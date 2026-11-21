import { DatabaseSync } from "node:sqlite";
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import {
  createMissionEngine,
  type MissionTenantPort,
} from "../../../src/application/missions/engine.js";
import { startMissionContent } from "../../../src/application/missions/history.js";
import { LlmRejectedError, LlmUnavailableError } from "../../../src/domain/errors.js";
import { DEFAULT_MISSION_LIMITS, type MissionLimits } from "../../../src/domain/missions/limits.js";
import type {
  LlmClient,
  LlmTurnRequest,
  LlmTurnResult,
} from "../../../src/domain/ports/LlmClient.js";
import type { MissionRow } from "../../../src/domain/ports/MissionStore.js";
import type { SentMessage, WhatsAppSender } from "../../../src/domain/ports/WhatsAppSender.js";
import { createSealedMissionLog } from "../../../src/infrastructure/missions/sealedMissionLog.js";
import { createSqliteEventStore } from "../../../src/infrastructure/missions/sqliteEventStore.js";
import { createSqliteMissionStore } from "../../../src/infrastructure/missions/sqliteMissionStore.js";
import { decodeMediaId, gowsMapper } from "../../../src/infrastructure/waha/engines/gows.js";
import { RecordingSender } from "../../fakes/InMemoryWahaGateway.js";
import { testCipher } from "../../fakes/testCipher.js";

const TENANT = "t1";
const OWNER = "51999000000@c.us";
const CHAT = "51911111111@c.us";
const LID = "123456789012345@lid";
const PROMPT = "Eres el asistente de Stiven. Coordina la reunión con Ana.";
const TZ = "America/Lima";
/** 10:00 in Lima (UTC-5, no DST). */
const T0 = new Date("2026-11-17T15:00:00.000Z");
const SEC = 1000;
const MIN = 60 * SEC;

/** Sends return realistic WhatsApp ids, like WAHA's `sendText`. */
class WaSender extends RecordingSender {
  private sent = 0;
  /** Sends to these chats throw (attempts are counted in `failedTo`). */
  failChats = new Set<string>();
  failedTo: string[] = [];
  override async sendText(q: Parameters<WhatsAppSender["sendText"]>[0]): Promise<SentMessage> {
    if (this.failChats.has(q.chatId)) {
      this.failedTo.push(q.text);
      throw new Error("send failed");
    }
    await super.sendText(q);
    this.sent += 1;
    return { id: `true_${q.chatId}_3EB0SENT${this.sent}`, timestamp: null };
  }
  texts(chatId: string): string[] {
    return this.calls
      .filter((c) => c.method === "sendText" && (c.args as { chatId: string }).chatId === chatId)
      .map((c) => (c.args as { text: string }).text);
  }
}

class FakeLlm implements LlmClient {
  requests: LlmTurnRequest[] = [];
  queue: (LlmTurnResult | Error)[] = [];
  async turn(q: LlmTurnRequest): Promise<LlmTurnResult> {
    this.requests.push(structuredClone(q));
    const next = this.queue.shift();
    if (!next) throw new Error("no scripted LLM reply");
    if (next instanceof Error) throw next;
    return next;
  }
}

const usage = {
  inputTokens: 100,
  outputTokens: 20,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0.001,
};

const block = (b: Record<string, unknown>) => b as unknown as Anthropic.ContentBlock;
const thinking = block({ type: "thinking", thinking: "Plan the reply.", signature: "sig-1" });
const text = (t: string) => block({ type: "text", text: t, citations: null });
let toolSeq = 0;
const tool = (name: string, input: unknown) =>
  block({ type: "tool_use", id: `toolu_${++toolSeq}`, name, input });

function reply(t: string | null, ...tools: Anthropic.ContentBlock[]): LlmTurnResult {
  return {
    content: [thinking, ...(t === null ? [] : [text(t)]), ...tools],
    stopReason: tools.length > 0 ? "tool_use" : "end_turn",
    usage,
  };
}

interface Options {
  limits?: Partial<MissionLimits>;
  spend?: number;
  waId?: string | null;
}

function harness(opts: Options = {}) {
  let now = T0;
  const authDb = new DatabaseSync(":memory:");
  const cacheDb = new DatabaseSync(":memory:");
  const cipher = testCipher(TENANT);
  const missions = createSqliteMissionStore(authDb, () => now.toISOString());
  const events = createSqliteEventStore(authDb, () => now.toISOString());
  const log = createSealedMissionLog(cacheDb, cipher);
  const sender = new WaSender();
  const llm = new FakeLlm();
  const usageRows: unknown[] = [];
  const transcribed: string[] = [];
  const fetched: string[] = [];
  const slept: number[] = [];
  const state = { spend: opts.spend ?? 0, status: "active" as string };
  const hooks: { onSleep?: () => void } = {};
  const port: MissionTenantPort = {
    log,
    sender,
    openEvent: (e) => cipher.openText(e.payloadSealed, `webhook:${e.tenantId}:${e.eventId}`),
    mapper: async () => gowsMapper,
    transcribe: async (mediaId) => {
      transcribed.push(mediaId);
      return "quiero el martes a las 3";
    },
    fetchMedia: async (mediaId) => {
      fetched.push(mediaId);
      return decodeMediaId(mediaId)?.messageId.includes("PDF")
        ? { data: new TextEncoder().encode("%PDF-1.4"), mimetype: "application/pdf" }
        : { data: new Uint8Array([137, 80, 78, 71]), mimetype: "image/png" };
    },
    lookupLid: async (lid) => (lid === LID ? CHAT : null),
  };
  const limits = { ...DEFAULT_MISSION_LIMITS, ...opts.limits };
  const tenants = {
    getTenant: (id: string) =>
      id === TENANT
        ? {
            id,
            wahaSession: "s1",
            displayName: "Stiven",
            status: state.status as "active",
            waId: opts.waId === undefined ? OWNER : opts.waId,
            createdAt: 0,
          }
        : null,
    recordLlmUsage: (q: unknown) => {
      usageRows.push(q);
    },
    llmSpendUsd: () => state.spend,
    /** Plus a revoked "t2" with no runtime (`acquire` returns null for it). */
    listTenants: () => [
      ...[tenants.getTenant(TENANT)].flatMap((t) => t ?? []),
      {
        id: "t2",
        wahaSession: "s2",
        displayName: "Otro",
        status: "revoked" as const,
        waId: null,
        createdAt: 0,
      },
    ],
  };
  const make = () =>
    createMissionEngine({
      missions,
      events,
      tenants,
      llm,
      model: "anthropic/claude-haiku-5.5",
      limits,
      monthlyBudgetUsd: 1,
      timezone: TZ,
      acquire: (id) => (id === TENANT ? { port, release() {} } : null),
      now: () => now,
      rand: () => 0.5,
      sleep: async (ms) => {
        slept.push(ms);
        hooks.onSleep?.();
      },
      logger: { info: () => {} },
    });
  let engine = make();
  let evt = 0;
  let msg = 0;

  const h = {
    missions,
    events,
    log,
    sender,
    llm,
    usageRows,
    transcribed,
    fetched,
    slept,
    state,
    hooks,
    get engine() {
      return engine;
    },
    restart() {
      engine.stop();
      engine = make();
    },
    get now() {
      return now;
    },
    at(ms: number) {
      now = new Date(T0.getTime() + ms);
      return now;
    },
    async tickAt(ms: number) {
      await engine.tick(h.at(ms));
    },
    start(
      q: Partial<Pick<MissionRow, "newContact" | "closingMessage" | "nextWakeAt">> & {
        minutes?: number;
      } = {},
    ): MissionRow {
      const m = missions.create({
        tenantId: TENANT,
        chatId: CHAT,
        newContact: q.newContact ?? false,
        deadlineAt: new Date(now.getTime() + (q.minutes ?? 60) * MIN).toISOString(),
        expectsFiles: false,
        nextWakeAt: q.nextWakeAt === undefined ? now.toISOString() : q.nextWakeAt,
        closingMessage: q.closingMessage ?? null,
      });
      startMissionContent(
        log,
        m.id,
        {
          systemPrompt: PROMPT,
          objective: "Agendar una reunión con Ana esta semana.",
          doneWhen: "Ana confirma día y hora.",
          contactName: "Ana",
        },
        now.toISOString(),
      );
      return m;
    },
    get(id: string): MissionRow {
      return missions.get(TENANT, id) as MissionRow;
    },
    /** Stores a sealed `message.any` webhook event; returns the WhatsApp message id. */
    message(q: {
      text?: string;
      message?: Record<string, unknown>;
      fromMe?: boolean;
      source?: "app" | "api";
      id?: string;
      from?: string;
      senderAlt?: string;
    }): string {
      msg += 1;
      const fromMe = q.fromMe ?? false;
      const from = q.from ?? CHAT;
      const shortId = `3EB0MSG${msg}`;
      const id = q.id ?? `${fromMe}_${from}_${shortId}`;
      const payload = {
        id,
        timestamp: Math.floor(now.getTime() / 1000),
        from,
        fromMe,
        source: q.source ?? "app",
        body: q.text ?? null,
        to: null,
        participant: null,
        hasMedia: Boolean(q.message),
        media: null,
        _data: {
          Info: {
            Chat: from,
            Sender: fromMe ? OWNER : from,
            ...(q.senderAlt ? { SenderAlt: q.senderAlt } : {}),
            IsFromMe: fromMe,
            ID: id.split("_")[2] ?? shortId,
            PushName: "Ana",
          },
          Message: q.message ?? { conversation: q.text ?? "" },
        },
      };
      h.envelope("message.any", payload);
      return id;
    },
    envelope(event: string, payload: unknown): void {
      evt += 1;
      const eventId = `evt_${evt}`;
      const body = JSON.stringify({
        id: eventId,
        timestamp: now.getTime(),
        event,
        session: "s1",
        payload,
      });
      events.put({
        tenantId: TENANT,
        eventId,
        kind: event === "session.status" ? "session.status" : "message",
        receivedAt: now.toISOString(),
        payloadSealed: cipher.sealText(body, `webhook:${TENANT}:${eventId}`),
      });
    },
    lastRequest(): LlmTurnRequest {
      const r = llm.requests.at(-1);
      if (!r) throw new Error("no LLM request");
      return r;
    },
    contactSends(): string[] {
      return sender.texts(CHAT);
    },
    ownerSends(): string[] {
      return sender.texts(OWNER);
    },
    entries(id: string) {
      return log.read(id);
    },
  };
  return h;
}

/** Text of every text block of a message's content. */
function textsOf(m: Anthropic.MessageParam | undefined): string[] {
  if (!m) return [];
  if (typeof m.content === "string") return [m.content];
  return (m.content as { type: string; text?: string }[])
    .filter((b) => b.type === "text")
    .map((b) => b.text as string);
}

const lastUser = (r: LlmTurnRequest) => [...r.messages].reverse().find((x) => x.role === "user");

/** Opens a mission and runs its opening turn. */
async function opened(h: ReturnType<typeof harness>, q: Parameters<typeof h.start>[0] = {}) {
  const m = h.start(q);
  h.llm.queue.push(reply("Hola Ana, soy el asistente de Stiven."));
  await h.tickAt(0);
  return m;
}

describe("mission engine: start", () => {
  it("runs the opening turn with Claude's prompt as the whole system prompt and sends it paced", async () => {
    const h = harness();
    const m = h.start();
    h.llm.queue.push(reply("Hola Ana, soy el asistente de Stiven."));
    await h.tickAt(0);

    expect(h.llm.requests).toHaveLength(1);
    const req = h.lastRequest();
    expect(req.system).toBe(PROMPT);
    const first = req.messages[0];
    expect(first?.role).toBe("user");
    const firstText = textsOf(first).join("\n");
    expect(firstText).toContain("Agendar una reunión con Ana esta semana.");
    expect(firstText).toContain("Ana confirma día y hora.");
    expect(textsOf(first).at(-1)).toBe("The mission starts now. Send your opening message.");
    // Server facts go as a system notice after the user turn, never in the system prompt.
    expect(req.messages[1]?.role).toBe("system");
    expect(textsOf(req.messages[1]).join(" ")).toContain("Deadline");

    expect(req.tools.map((t) => t.name).sort()).toEqual([
      "ask_owner",
      "finish_mission",
      "no_reply",
    ]);
    for (const t of req.tools) expect((t as { strict?: boolean }).strict).toBe(true);
    // Haiku's thinking blocks count against max_tokens: room for thinking plus the reply.
    expect(req.maxTokens).toBe(4000);

    expect(h.sender.calls.map((c) => c.method)).toEqual(["startTyping", "stopTyping", "sendText"]);
    expect(h.contactSends()).toEqual(["Hola Ana, soy el asistente de Stiven."]);
    expect(h.slept).toHaveLength(1);

    const row = h.get(m.id);
    expect(row.state).toBe("active");
    expect(row.sentCount).toBe(1);
    expect(row.llmCalls).toBe(1);
    expect(row.lastAgentAt).toBe(T0.toISOString());
    expect(h.usageRows).toEqual([
      {
        tenantId: TENANT,
        missionId: m.id,
        at: T0.toISOString(),
        model: "anthropic/claude-haiku-5.5",
        kind: "agent",
        usage,
      },
    ]);
  });

  it("postpones the opening to 08:00 when the mission starts in quiet hours", async () => {
    const h = harness();
    h.at(13 * 60 * MIN); // 23:00 Lima
    const m = h.start({ minutes: 600 });
    await h.tickAt(13 * 60 * MIN);
    expect(h.llm.requests).toHaveLength(0);
    expect(h.sender.calls).toHaveLength(0);
    expect(h.get(m.id).nextWakeAt).toBe("2026-11-18T13:00:00.000Z");

    h.llm.queue.push(reply("Buenos días Ana."));
    await h.engine.tick(new Date("2026-11-18T13:00:00.000Z"));
    expect(h.contactSends()).toEqual(["Buenos días Ana."]);
  });
});

describe("mission engine: inbound messages", () => {
  it("batches three bubbles within the debounce window into one agent turn", async () => {
    const h = harness();
    const m = await opened(h);
    const ids = [h.message({ text: "hola" })];
    await h.tickAt(1 * SEC);
    expect(h.get(m.id).nextWakeAt).toBe(new Date(T0.getTime() + 16 * SEC).toISOString());
    h.at(6 * SEC);
    ids.push(h.message({ text: "sí puedo" }));
    await h.tickAt(6 * SEC);
    h.at(11 * SEC);
    ids.push(h.message({ text: "el martes" }));
    await h.tickAt(11 * SEC);
    await h.tickAt(20 * SEC);
    expect(h.llm.requests).toHaveLength(1);

    h.llm.queue.push(reply("Perfecto, ¿a qué hora el martes?"));
    await h.tickAt(26 * SEC);
    expect(h.llm.requests).toHaveLength(2);
    const req = h.lastRequest();
    const lastUser = [...req.messages].reverse().find((x) => x.role === "user");
    expect(textsOf(lastUser)).toEqual(["hola", "sí puedo", "el martes"]);
    const seen = h.sender.calls.filter((c) => c.method === "sendSeen");
    expect(seen.at(-1)?.args).toEqual({ chatId: CHAT, messageIds: ids });
    expect(h.contactSends().at(-1)).toBe("Perfecto, ¿a qué hora el martes?");
    expect(h.get(m.id).lastInboundAt).toBe(new Date(T0.getTime() + 11 * SEC).toISOString());
  });

  it("keeps the history append-only, with assistant content exactly as returned", async () => {
    const h = harness();
    await opened(h);
    h.message({ text: "hola" });
    await h.tickAt(1 * SEC);
    h.llm.queue.push(reply("¿Qué día te queda?"));
    await h.tickAt(20 * SEC);
    const [first, second] = h.llm.requests;
    expect(second?.messages.slice(0, first?.messages.length)).toEqual(first?.messages);
    const assistant = second?.messages[first?.messages.length ?? 0];
    expect(assistant).toEqual({
      role: "assistant",
      content: [thinking, text("Hola Ana, soy el asistente de Stiven.")],
    });
  });

  it("transcribes voice notes and attaches images and PDFs as content blocks", async () => {
    const h = harness();
    await opened(h);
    h.message({
      message: { audioMessage: { mimetype: "audio/ogg; codecs=opus", PTT: true, seconds: 4 } },
    });
    h.message({ message: { imageMessage: { mimetype: "image/png", caption: "mi agenda" } } });
    h.message({
      id: `false_${CHAT}_3EB0PDF1`,
      message: { documentMessage: { mimetype: "application/pdf", fileName: "cv.pdf" } },
    });
    await h.tickAt(1 * SEC);
    expect(h.transcribed).toHaveLength(1);
    expect(h.fetched).toHaveLength(2);

    h.llm.queue.push(reply("Gracias, lo reviso."));
    await h.tickAt(20 * SEC);
    const lastUser = [...h.lastRequest().messages].reverse().find((x) => x.role === "user");
    const blocks = lastUser?.content as { type: string; text?: string; source?: unknown }[];
    expect(
      blocks.some((b) => b.type === "text" && b.text?.includes("quiero el martes a las 3")),
    ).toBe(true);
    expect(blocks.find((b) => b.type === "image")?.source).toEqual({
      type: "base64",
      media_type: "image/png",
      data: Buffer.from([137, 80, 78, 71]).toString("base64"),
    });
    expect(blocks.some((b) => b.type === "text" && b.text?.includes("mi agenda"))).toBe(true);
    expect(blocks.find((b) => b.type === "document")?.source).toEqual({
      type: "base64",
      media_type: "application/pdf",
      data: Buffer.from("%PDF-1.4").toString("base64"),
    });
  });

  it("matches a mission chat when the event uses the @lid id", async () => {
    const h = harness();
    const m = await opened(h);
    h.message({ from: LID, text: "hola" });
    await h.tickAt(1 * SEC);
    expect(h.get(m.id).lastInboundAt).not.toBeNull();
    h.message({
      from: "987654321098765@lid",
      senderAlt: "51911111111:12@s.whatsapp.net",
      text: "otra",
    });
    await h.tickAt(2 * SEC);
    expect(h.get(m.id).lastInboundAt).toBe(new Date(T0.getTime() + 2 * SEC).toISOString());
  });

  it("ignores the contact's group and Status messages (only the direct chat feeds the mission)", async () => {
    const h = harness();
    const m = await opened(h);
    const before = h.entries(m.id).length;
    h.message({
      from: "120363000000000001@g.us",
      senderAlt: "51911111111@s.whatsapp.net",
      text: "en el grupo",
    });
    h.message({ from: "120363000000000002@g.us", senderAlt: LID, text: "otro grupo" });
    h.message({
      from: "status@broadcast",
      senderAlt: "51911111111:3@s.whatsapp.net",
      text: "mi estado",
    });
    await h.tickAt(1 * SEC);
    await h.tickAt(30 * SEC);
    expect(h.llm.requests).toHaveLength(1);
    expect(h.contactSends()).toHaveLength(1);
    expect(h.entries(m.id)).toHaveLength(before);
    expect(h.get(m.id).lastInboundAt).toBeNull();
    expect(h.get(m.id).state).toBe("active");

    h.message({ text: "hola" });
    await h.tickAt(31 * SEC);
    expect(h.get(m.id).lastInboundAt).not.toBeNull();
  });

  it("ignores the echo of its own sends", async () => {
    const h = harness();
    const m = await opened(h);
    h.message({ fromMe: true, source: "api", id: `true_${CHAT}_3EB0SENT1` });
    await h.tickAt(1 * SEC);
    expect(h.get(m.id).state).toBe("active");
  });

  it("ends as taken_over when the owner writes from the phone, and sends nothing more", async () => {
    const h = harness();
    const m = await opened(h);
    h.message({ text: "hola" });
    h.message({ fromMe: true, source: "app", text: "Ana, te escribo yo" });
    await h.tickAt(1 * SEC);
    const row = h.get(m.id);
    expect(row.state).toBe("taken_over");
    expect(row.endedAt).toBe(new Date(T0.getTime() + 1 * SEC).toISOString());
    const before = h.sender.calls.length;
    await h.tickAt(60 * SEC);
    expect(h.sender.calls.length).toBe(before);
    expect(h.llm.requests).toHaveLength(1);
  });

  it("ends as taken_over when the owner sends through the API (an id the engine did not send)", async () => {
    const h = harness();
    const m = await opened(h);
    h.message({ fromMe: true, source: "api", text: "enviado con send_text" });
    await h.tickAt(1 * SEC);
    expect(h.get(m.id).state).toBe("taken_over");
  });

  it("the owner's own edit, revoke and reaction echoes do not take the mission over", async () => {
    const h = harness();
    const m = await opened(h);
    const key = { ID: "3EB0OLD", RemoteJID: CHAT, FromMe: true };
    // edit_message echo: protocolMessage wrapping the edited content.
    h.message({
      fromMe: true,
      source: "api",
      message: {
        protocolMessage: { type: 14, key, editedMessage: { conversation: "texto corregido" } },
      },
    });
    // delete_message echo: protocolMessage REVOKE (numeric 0 and named form).
    h.message({ fromMe: true, source: "api", message: { protocolMessage: { type: 0, key } } });
    h.message({
      fromMe: true,
      source: "api",
      message: { protocolMessage: { type: "REVOKE", key } },
    });
    // A top-level editedMessage container.
    h.message({
      fromMe: true,
      source: "api",
      message: { editedMessage: { message: { conversation: "otro" } } },
    });
    h.message({
      fromMe: true,
      source: "api",
      message: { reactionMessage: { key, text: "👍" } },
    });
    await h.tickAt(1 * SEC);
    expect(h.get(m.id).state).toBe("active");
  });
});

describe("mission engine: agent tools", () => {
  it("finish_mission succeeded: logs summary and collected items, sends the text, notifies the owner", async () => {
    const h = harness();
    const m = await opened(h);
    h.message({ text: "el martes a las 3 me va bien" });
    await h.tickAt(1 * SEC);
    h.llm.queue.push(
      reply(
        "¡Listo, nos vemos el martes!",
        tool("finish_mission", {
          outcome: "succeeded",
          summary: "Reunión el martes a las 15:00.",
          collected: [{ label: "hora", value: "martes 15:00" }],
        }),
      ),
    );
    await h.tickAt(20 * SEC);
    const row = h.get(m.id);
    expect(row.state).toBe("succeeded");
    expect(row.endedAt).not.toBeNull();
    expect(row.nextWakeAt).toBeNull();
    expect(h.contactSends().at(-1)).toBe("¡Listo, nos vemos el martes!");
    expect(h.ownerSends()).toEqual(["✅ Misión con Ana cumplida: Reunión el martes a las 15:00."]);
    const kinds = h.entries(m.id).map((e) => e.kind);
    expect(kinds).toContain("summary");
    expect(h.entries(m.id).find((e) => e.kind === "collected")?.body).toEqual([
      { label: "hora", value: "martes 15:00" },
    ]);
    // The owner notification is a plain send: no typing around it.
    expect(h.sender.calls.at(-1)?.method).toBe("sendText");
    expect(h.sender.calls.at(-2)?.method).toBe("sendText");
  });

  it("finish_mission failed notifies the owner", async () => {
    const h = harness();
    const m = await opened(h);
    h.message({ text: "no puedo esta semana" });
    await h.tickAt(1 * SEC);
    h.llm.queue.push(
      reply(null, tool("finish_mission", { outcome: "failed", summary: "Ana no puede." })),
    );
    await h.tickAt(20 * SEC);
    expect(h.get(m.id).state).toBe("failed");
    expect(h.ownerSends()).toEqual(["⚠️ Misión con Ana fallida: Ana no puede."]);
  });

  it("ask_owner logs the question, notifies the owner and still sends the reply; the answer comes back as a notice", async () => {
    const h = harness();
    const m = await opened(h);
    h.message({ text: "¿puede ser en su oficina?" });
    await h.tickAt(1 * SEC);
    h.llm.queue.push(
      reply(
        "Lo consulto y te confirmo.",
        tool("ask_owner", { question: "¿Puede ser en tu oficina?" }),
      ),
    );
    await h.tickAt(20 * SEC);
    expect(h.get(m.id).state).toBe("active");
    expect(h.contactSends().at(-1)).toBe("Lo consulto y te confirmo.");
    expect(h.ownerSends()).toEqual(["❓ Ana pregunta: ¿Puede ser en tu oficina?"]);
    expect(h.entries(m.id).find((e) => e.kind === "question")?.body).toEqual({
      question: "¿Puede ser en tu oficina?",
    });

    h.at(2 * MIN);
    expect(await h.engine.answer(TENANT, m.id, "Sí, en mi oficina.")).toBe(true);
    h.llm.queue.push(reply("Sí, puede ser en su oficina."));
    await h.tickAt(2 * MIN);
    const req = h.lastRequest();
    const system = req.messages.filter((x) => x.role === "system").flatMap(textsOf);
    expect(system.some((t) => t.includes("Sí, en mi oficina."))).toBe(true);
    const toolResults = req.messages
      .filter((x) => x.role === "user" && Array.isArray(x.content))
      .flatMap((x) => x.content as { type: string }[])
      .filter((b) => b.type === "tool_result");
    expect(toolResults).toHaveLength(1);
    expect(h.contactSends().at(-1)).toBe("Sí, puede ser en su oficina.");
  });

  it("no_reply sends nothing", async () => {
    const h = harness();
    const m = await opened(h);
    h.message({ text: "ok 👍" });
    await h.tickAt(1 * SEC);
    h.llm.queue.push(reply(null, tool("no_reply", {})));
    await h.tickAt(20 * SEC);
    expect(h.contactSends()).toHaveLength(1);
    expect(h.get(m.id).sentCount).toBe(1);
    expect(h.get(m.id).llmCalls).toBe(2);
  });
});

describe("mission engine: time", () => {
  it("expires after the deadline and notifies the owner", async () => {
    const h = harness();
    const m = await opened(h, { minutes: 10 });
    await h.tickAt(10 * MIN);
    const row = h.get(m.id);
    expect(row.state).toBe("expired");
    expect(row.nextWakeAt).toBeNull();
    expect(h.ownerSends()).toEqual(["⏱️ Misión con Ana vencida"]);
    expect(h.llm.requests).toHaveLength(1);
  });

  it("sends a reminder turn after the gap when the contact is silent", async () => {
    const h = harness();
    const m = await opened(h);
    expect(h.get(m.id).nextWakeAt).toBe(new Date(T0.getTime() + 30 * MIN).toISOString());
    await h.tickAt(29 * MIN);
    expect(h.llm.requests).toHaveLength(1);
    h.llm.queue.push(reply("¿Pudiste verlo, Ana?"));
    await h.tickAt(30 * MIN);
    expect(textsOf(lastUser(h.lastRequest())).at(-1)).toBe(
      "No reply yet. Send a short, friendly reminder.",
    );
    expect(h.contactSends().at(-1)).toBe("¿Pudiste verlo, Ana?");
    expect(h.get(m.id).reminderCount).toBe(1);
  });

  it("caps reminders at one for a new contact", async () => {
    const h = harness();
    const m = await opened(h, { newContact: true, minutes: 120 });
    h.llm.queue.push(reply("¿Pudiste verlo?"));
    await h.tickAt(30 * MIN);
    expect(h.get(m.id).reminderCount).toBe(1);
    await h.tickAt(61 * MIN);
    expect(h.llm.requests).toHaveLength(2);
    expect(h.get(m.id).nextWakeAt).toBe(h.get(m.id).deadlineAt);
  });

  it("postpones a reminder that falls in quiet hours to 08:00", async () => {
    const h = harness();
    h.at(11 * 60 * MIN + 40 * MIN); // 21:40 Lima; quiet hours start at 22:00
    const m = h.start({ minutes: 120 });
    h.llm.queue.push(reply("Hola Ana."));
    await h.tickAt(11 * 60 * MIN + 40 * MIN);
    await h.tickAt(12 * 60 * MIN + 10 * MIN); // 22:10 Lima, reminder due
    expect(h.llm.requests).toHaveLength(1);
    expect(h.get(m.id).nextWakeAt).toBe(h.get(m.id).deadlineAt);
  });
});

describe("mission engine: caps and failures", () => {
  it("stops at the message cap", async () => {
    const h = harness({ limits: { maxMessagesPerMission: 1 } });
    const m = await opened(h);
    h.message({ text: "hola" });
    await h.tickAt(1 * SEC);
    await h.tickAt(20 * SEC);
    const row = h.get(m.id);
    expect(row.state).toBe("stopped");
    expect(row.stopReason).toBe("message_cap");
    expect(h.llm.requests).toHaveLength(1);
    expect(h.ownerSends()).toEqual(["⛔ Misión con Ana detenida (límite de mensajes)"]);
  });

  it("stops at the LLM call cap", async () => {
    const h = harness({ limits: { maxLlmCallsPerMission: 1 } });
    const m = await opened(h);
    h.message({ text: "hola" });
    await h.tickAt(1 * SEC);
    await h.tickAt(20 * SEC);
    expect(h.get(m.id).stopReason).toBe("llm_cap");
    expect(h.llm.requests).toHaveLength(1);
  });

  it("stops when the monthly budget is spent", async () => {
    const h = harness({ spend: 1 });
    const m = h.start();
    await h.tickAt(0);
    expect(h.get(m.id).stopReason).toBe("budget");
    expect(h.llm.requests).toHaveLength(0);
    expect(h.ownerSends()).toEqual(["⛔ Misión con Ana detenida (presupuesto mensual agotado)"]);
  });

  it("stops on a refusal and sends nothing", async () => {
    const h = harness();
    const m = h.start();
    h.llm.queue.push({ content: [], stopReason: "refusal", usage });
    await h.tickAt(0);
    expect(h.get(m.id).state).toBe("stopped");
    expect(h.get(m.id).stopReason).toBe("refusal");
    expect(h.contactSends()).toEqual([]);
    expect(h.usageRows).toHaveLength(1);
  });

  it("retries an unavailable LLM at +30 s, +2 min, +5 min, then stops with errors", async () => {
    const h = harness();
    const m = h.start();
    for (let i = 0; i < 4; i++) h.llm.queue.push(new LlmUnavailableError(503));
    await h.tickAt(0);
    expect(h.get(m.id).nextWakeAt).toBe(new Date(T0.getTime() + 30 * SEC).toISOString());
    await h.tickAt(30 * SEC);
    expect(h.get(m.id).nextWakeAt).toBe(new Date(T0.getTime() + 150 * SEC).toISOString());
    await h.tickAt(150 * SEC);
    expect(h.get(m.id).nextWakeAt).toBe(new Date(T0.getTime() + 450 * SEC).toISOString());
    await h.tickAt(450 * SEC);
    expect(h.llm.requests).toHaveLength(4);
    expect(h.get(m.id).state).toBe("stopped");
    expect(h.get(m.id).stopReason).toBe("errors");
    expect(h.contactSends()).toEqual([]);
    // A retried turn never repeats its instruction in the history.
    const opening = h
      .lastRequest()
      .messages.flatMap(textsOf)
      .filter((t) => t === "The mission starts now. Send your opening message.");
    expect(opening).toHaveLength(1);
  });

  it("resends a failed opening at +30 s, +2 min, +5 min without a new LLM call, then stops with errors", async () => {
    const h = harness();
    const m = h.start();
    h.sender.failChats.add(CHAT);
    h.llm.queue.push(reply("Hola Ana, soy el asistente de Stiven."));
    await h.tickAt(0);
    expect(h.sender.failedTo).toHaveLength(1);
    expect(h.get(m.id).nextWakeAt).toBe(new Date(T0.getTime() + 30 * SEC).toISOString());
    await h.tickAt(30 * SEC);
    expect(h.get(m.id).nextWakeAt).toBe(new Date(T0.getTime() + 150 * SEC).toISOString());
    await h.tickAt(150 * SEC);
    expect(h.get(m.id).nextWakeAt).toBe(new Date(T0.getTime() + 450 * SEC).toISOString());
    expect(h.get(m.id).state).toBe("active");
    await h.tickAt(450 * SEC);
    expect(h.sender.failedTo).toEqual(Array(4).fill("Hola Ana, soy el asistente de Stiven."));
    expect(h.llm.requests).toHaveLength(1);
    expect(h.get(m.id).state).toBe("stopped");
    expect(h.get(m.id).stopReason).toBe("errors");
    expect(h.ownerSends()).toEqual(["⛔ Misión con Ana detenida (errores del modelo)"]);
  });

  it("a resent opening that goes through continues the mission normally", async () => {
    const h = harness();
    const m = h.start();
    h.sender.failChats.add(CHAT);
    h.llm.queue.push(reply("Hola Ana, soy el asistente de Stiven."));
    await h.tickAt(0);
    h.sender.failChats.clear();
    await h.tickAt(30 * SEC);
    expect(h.contactSends()).toEqual(["Hola Ana, soy el asistente de Stiven."]);
    expect(h.llm.requests).toHaveLength(1);
    const row = h.get(m.id);
    expect(row.state).toBe("active");
    expect(row.sentCount).toBe(1);
    expect(row.lastAgentAt).toBe(new Date(T0.getTime() + 30 * SEC).toISOString());
    expect(row.nextWakeAt).toBe(
      new Date(T0.getTime() + 30 * SEC + DEFAULT_MISSION_LIMITS.reminderGapMs).toISOString(),
    );
  });

  it("stops at once on a rejected request", async () => {
    const h = harness();
    const m = h.start();
    h.llm.queue.push(new LlmRejectedError(400));
    await h.tickAt(0);
    expect(h.get(m.id).stopReason).toBe("errors");
    expect(h.ownerSends()).toEqual(["⛔ Misión con Ana detenida (errores del modelo)"]);
  });
});

describe("mission engine: reach-out timelock", () => {
  const lock = (isActive: boolean) => ({
    name: "s1",
    status: "WORKING",
    statuses: [],
    data: null,
    reachoutTimelock: { isActive },
  });

  it("pauses the tenant's missions while the lock is active and resumes when it lifts", async () => {
    const h = harness();
    const m = await opened(h);
    h.envelope("session.status", lock(true));
    h.message({ text: "hola" });
    await h.tickAt(1 * SEC);
    await h.tickAt(30 * SEC);
    expect(h.llm.requests).toHaveLength(1);
    expect(h.contactSends()).toHaveLength(1);
    expect(h.get(m.id).state).toBe("active");

    h.at(40 * SEC);
    h.envelope("session.status", lock(false));
    h.llm.queue.push(reply("Hola de nuevo."));
    await h.tickAt(40 * SEC);
    expect(h.llm.requests).toHaveLength(2);
    expect(h.contactSends().at(-1)).toBe("Hola de nuevo.");
  });

  it("keeps the deadline running while paused", async () => {
    const h = harness();
    const m = await opened(h, { minutes: 5 });
    h.envelope("session.status", lock(true));
    await h.tickAt(1 * SEC);
    await h.tickAt(5 * MIN);
    expect(h.get(m.id).state).toBe("expired");
  });
});

describe("mission engine: reach-out pause expiry", () => {
  const HOUR = 60 * MIN;
  const status = (reachoutTimelock: Record<string, unknown>) => ({
    name: "s1",
    status: "WORKING",
    statuses: [],
    data: null,
    reachoutTimelock,
  });

  it("lifts a pause with no end time after 24 h, even when no unlock status arrives", async () => {
    const h = harness();
    const m = await opened(h, { minutes: 30 * 60 });
    h.envelope("session.status", status({ isActive: true }));
    h.message({ text: "hola" });
    await h.tickAt(1 * SEC);
    await h.tickAt(23 * HOUR);
    expect(h.llm.requests).toHaveLength(1);

    h.llm.queue.push(reply("Hola de nuevo."));
    await h.tickAt(24 * HOUR + 1 * SEC);
    expect(h.llm.requests).toHaveLength(2);
    expect(h.contactSends().at(-1)).toBe("Hola de nuevo.");
    expect(h.get(m.id).state).toBe("active");
  });

  it("uses the lock's own end time when the status carries one", async () => {
    const h = harness();
    await opened(h, { minutes: 5 * 60 });
    const ends = new Date(T0.getTime() + 2 * HOUR).toISOString();
    h.envelope("session.status", status({ isActive: true, timeEnforcementEnds: ends }));
    h.message({ text: "hola" });
    await h.tickAt(1 * SEC);
    await h.tickAt(2 * HOUR - 1 * SEC);
    expect(h.llm.requests).toHaveLength(1);

    h.llm.queue.push(reply("Ya puedo escribirte."));
    await h.tickAt(2 * HOUR + 1 * SEC);
    expect(h.llm.requests).toHaveLength(2);
    expect(h.contactSends().at(-1)).toBe("Ya puedo escribirte.");
  });

  it("an explicit unlock still lifts the pause at once", async () => {
    const h = harness();
    await opened(h);
    h.envelope("session.status", status({ isActive: true }));
    await h.tickAt(1 * SEC);
    h.at(10 * SEC);
    h.envelope("session.status", status({ isActive: false }));
    h.message({ text: "hola" });
    h.llm.queue.push(reply("Hola."));
    await h.tickAt(10 * SEC);
    await h.tickAt(30 * SEC);
    expect(h.llm.requests).toHaveLength(2);
  });
});

describe("mission engine: closing message", () => {
  it("sends one paced closing line when an expired mission has a closing message", async () => {
    const h = harness();
    const m = await opened(h, { minutes: 10, closingMessage: "yes" });
    h.llm.queue.push(reply("Le paso esto a Stiven, ¡gracias!"));
    await h.tickAt(10 * MIN);
    expect(h.get(m.id).state).toBe("expired");
    expect(textsOf(lastUser(h.lastRequest())).at(-1)).toBe(
      "The mission is over (expired). Send one short closing message.",
    );
    expect(h.contactSends()).toEqual([
      "Hola Ana, soy el asistente de Stiven.",
      "Le paso esto a Stiven, ¡gracias!",
    ]);
  });

  it("sends the closing line on cancel", async () => {
    const h = harness();
    const m = await opened(h, { closingMessage: "yes" });
    h.llm.queue.push(reply("Stiven te escribirá."));
    h.at(5 * MIN);
    expect(await h.engine.cancel(TENANT, m.id)).toBe(true);
    expect(h.get(m.id).state).toBe("cancelled");
    expect(textsOf(lastUser(h.lastRequest())).at(-1)).toBe(
      "The mission is over (cancelled). Send one short closing message.",
    );
    expect(h.contactSends().at(-1)).toBe("Stiven te escribirá.");
    expect(await h.engine.cancel(TENANT, m.id)).toBe(false);
  });

  it("takes a mission over at once when the owner sends through the MCP tools", async () => {
    const h = harness();
    const m = await opened(h, { closingMessage: "yes" });
    const sends = h.sender.calls.length;
    h.at(5 * MIN);
    expect(await h.engine.takeOver(TENANT, m.id)).toBe(true);
    expect(h.get(m.id)).toMatchObject({ state: "taken_over", nextWakeAt: null });
    // Silent: no closing line, no owner notice.
    expect(h.sender.calls.length).toBe(sends);
    expect(await h.engine.takeOver(TENANT, m.id)).toBe(false);
  });

  it("drops a reply still in its typing delay when the owner takes the mission over", async () => {
    const h = harness();
    const m = await opened(h);
    const before = h.contactSends().length;
    h.message({ text: "¿puede ser el viernes?" });
    h.at(1 * MIN);
    await h.engine.tick(h.now);
    h.llm.queue.push(reply("Déjame revisar con Stiven."));
    // The owner sends while the agent is "typing".
    h.hooks.onSleep = () => {
      h.hooks.onSleep = undefined;
      void h.engine.takeOver(TENANT, m.id);
    };
    await h.tickAt(2 * MIN);
    await h.engine.idle();
    expect(h.contactSends().length).toBe(before);
    expect(h.get(m.id).state).toBe("taken_over");
  });

  it("goes silent without a closing message", async () => {
    const h = harness();
    const m = await opened(h, { minutes: 10 });
    await h.tickAt(10 * MIN);
    expect(h.get(m.id).state).toBe("expired");
    expect(h.contactSends()).toHaveLength(1);
  });
});

describe("mission engine: cache events", () => {
  it("leaves cache events for the cache processor", async () => {
    const h = harness();
    h.events.put({
      tenantId: TENANT,
      eventId: "evt_cache",
      kind: "message.reaction",
      receivedAt: new Date().toISOString(),
      payloadSealed: "sealed",
    });
    await h.tickAt(1 * SEC);
    expect(h.events.pending(10).map((e) => e.eventId)).toEqual(["evt_cache"]);
  });
});

describe("mission engine: restart", () => {
  it("resumes due missions and pending events over the same stores with no duplicate sends", async () => {
    const h = harness();
    const m = await opened(h);
    h.message({ fromMe: true, source: "api", id: `true_${CHAT}_3EB0SENT1` });
    h.message({ text: "hola" });
    h.restart();
    await h.tickAt(1 * SEC);
    expect(h.get(m.id).state).toBe("active");
    expect(h.contactSends()).toHaveLength(1);
    h.llm.queue.push(reply("¿Cuándo te viene bien?"));
    h.restart();
    await h.tickAt(20 * SEC);
    await h.tickAt(21 * SEC);
    expect(h.contactSends()).toEqual([
      "Hola Ana, soy el asistente de Stiven.",
      "¿Cuándo te viene bien?",
    ]);
    expect(h.events.pending(10)).toEqual([]);
  });
});

describe("mission engine: wake", () => {
  it("wake runs a tick without waiting for the interval", async () => {
    const h = harness();
    h.start();
    h.llm.queue.push(reply("Hola."));
    h.engine.wake();
    await h.engine.idle();
    expect(h.contactSends()).toEqual(["Hola."]);
  });
});

describe("mission engine: fix round 1", () => {
  const lock = (isActive: boolean) => ({
    name: "s1",
    status: "WORKING",
    statuses: [],
    data: null,
    reachoutTimelock: { isActive },
  });

  it("keeps the reach-out pause across a restart until an explicit unlock", async () => {
    const h = harness();
    const m = await opened(h);
    h.envelope("session.status", lock(true));
    await h.tickAt(1 * SEC);
    h.restart();
    h.message({ text: "hola" });
    await h.tickAt(2 * SEC);
    await h.tickAt(30 * SEC);
    expect(h.llm.requests).toHaveLength(1);
    expect(h.contactSends()).toHaveLength(1);

    h.at(40 * SEC);
    h.envelope("session.status", { name: "s1", status: "WORKING", statuses: [], data: null });
    await h.tickAt(40 * SEC);
    expect(h.llm.requests).toHaveLength(1);

    h.envelope("session.status", lock(false));
    h.llm.queue.push(reply("Hola de nuevo."));
    await h.tickAt(41 * SEC);
    expect(h.llm.requests).toHaveLength(2);
    expect(h.contactSends().at(-1)).toBe("Hola de nuevo.");
    expect(h.get(m.id).state).toBe("active");
  });

  it("stop during a paced send lets that send finish and log its id, and starts no new turn", async () => {
    const h = harness();
    const first = h.start({ closingMessage: "yes" });
    const second = h.start({ closingMessage: "yes" });
    h.llm.queue.push(reply("Hola Ana."), reply("Hola otra vez."), reply("Adiós."));
    h.hooks.onSleep = () => h.engine.stop();
    await h.tickAt(0);
    await h.engine.idle();
    expect(h.llm.requests).toHaveLength(1);
    expect(h.contactSends()).toEqual(["Hola Ana."]);
    const sentMission = [first, second].find((m) => h.get(m.id).sentCount === 1);
    expect(sentMission).toBeDefined();
    expect(h.entries(sentMission?.id as string).filter((e) => e.kind === "sent")).toHaveLength(1);
    await h.tickAt(1 * SEC);
    h.engine.wake();
    await h.engine.idle();
    // A cancel after stop records the state but runs no closing turn.
    const idle = [first, second].find((m) => m.id !== sentMission?.id) as MissionRow;
    await h.engine.cancel(TENANT, idle.id);
    expect(h.get(idle.id).state).toBe("cancelled");
    expect(h.llm.requests).toHaveLength(1);
    expect(h.contactSends()).toEqual(["Hola Ana."]);
  });

  it("dedupes a redelivered contact message by its id", async () => {
    const h = harness();
    await opened(h);
    const id = `false_${CHAT}_3EB0DUP1`;
    h.message({ id, text: "hola" });
    h.message({ id, text: "hola" });
    await h.tickAt(1 * SEC);
    h.message({ id, text: "hola" });
    await h.tickAt(2 * SEC);
    h.llm.queue.push(reply("¡Hola!"));
    await h.tickAt(20 * SEC);
    expect(textsOf(lastUser(h.lastRequest()))).toEqual(["hola"]);
    expect(h.sender.calls.filter((c) => c.method === "sendSeen").at(-1)?.args).toEqual({
      chatId: CHAT,
      messageIds: [id],
    });
  });

  it("postpones the closing line to 08:00 when the mission ends in quiet hours", async () => {
    const h = harness();
    h.at(11 * 60 * MIN + 40 * MIN); // 21:40 Lima
    const m = h.start({ minutes: 50, closingMessage: "yes" });
    h.llm.queue.push(reply("Hola Ana."));
    await h.tickAt(11 * 60 * MIN + 40 * MIN);
    await h.tickAt(12 * 60 * MIN + 30 * MIN); // 22:30 Lima: deadline, quiet
    expect(h.get(m.id).state).toBe("expired");
    expect(h.llm.requests).toHaveLength(1);
    expect(h.get(m.id).nextWakeAt).toBe("2026-11-18T13:00:00.000Z");

    h.llm.queue.push(reply("Le paso esto a Stiven."));
    await h.engine.tick(new Date("2026-11-18T13:00:00.000Z"));
    expect(textsOf(lastUser(h.lastRequest())).at(-1)).toBe(
      "The mission is over (expired). Send one short closing message.",
    );
    expect(h.contactSends()).toEqual(["Hola Ana.", "Le paso esto a Stiven."]);
    expect(h.get(m.id).nextWakeAt).toBeNull();
    await h.engine.tick(new Date("2026-11-18T13:01:00.000Z"));
    expect(h.llm.requests).toHaveLength(2);
  });
});

describe("mission engine: retention", () => {
  const DAY = 24 * 60 * MIN;
  /** An ended mission (no closing due) with content, `daysAgo` days before the clock. */
  function ended(h: ReturnType<typeof harness>, daysAgo: number): MissionRow {
    const m = h.start({ nextWakeAt: null, closingMessage: "yes" });
    h.missions.update(m.id, {
      state: "cancelled",
      stopReason: null,
      endedAt: new Date(h.now.getTime() - daysAgo * DAY).toISOString(),
    });
    return m;
  }

  it("deletes the content and row of missions ended more than 30 days ago and keeps newer ones", async () => {
    const h = harness();
    const old = ended(h, 31);
    const recent = ended(h, 29);
    const active = h.start({ nextWakeAt: null });
    await h.tickAt(0);
    expect(h.log.read(old.id)).toEqual([]);
    expect(h.missions.get(TENANT, old.id)).toBeNull();
    expect(h.log.read(recent.id).length).toBeGreaterThan(0);
    expect(h.get(recent.id).closingMessage).toBe("yes");
    expect(h.log.read(active.id).length).toBeGreaterThan(0);
    expect(h.get(active.id).state).toBe("active");
  });

  it("prunes webhook events received more than 7 days ago in the same purge", async () => {
    const h = harness();
    const put = (eventId: string, daysAgo: number) =>
      h.events.put({
        tenantId: TENANT,
        eventId,
        kind: "message",
        receivedAt: new Date(h.now.getTime() - daysAgo * DAY).toISOString(),
        payloadSealed: "",
      });
    put("evt_old", 8);
    put("evt_new", 6);
    for (const e of h.events.pending(10)) h.events.markDone(e.id);
    await h.tickAt(0);
    expect(put("evt_old", 8)).toBe("stored");
    expect(put("evt_new", 6)).toBe("duplicate");
  });

  it("purges on the first tick after boot, then at most once per day", async () => {
    const h = harness();
    await h.tickAt(0);
    const m = ended(h, 31);
    await h.tickAt(23 * 60 * MIN);
    expect(h.missions.get(TENANT, m.id)).not.toBeNull();
    await h.tickAt(DAY);
    expect(h.missions.get(TENANT, m.id)).toBeNull();
    // A restarted process purges again on its first tick.
    const n = ended(h, 31);
    h.restart();
    await h.tickAt(DAY + MIN);
    expect(h.missions.get(TENANT, n.id)).toBeNull();
  });

  it("keeps the content of a tenant without a runtime until it can be purged", async () => {
    const h = harness();
    const m = ended(h, 31);
    const other = h.missions.create({
      tenantId: "t2",
      chatId: CHAT,
      newContact: false,
      deadlineAt: h.now.toISOString(),
      expectsFiles: false,
    });
    h.missions.update(other.id, {
      state: "cancelled",
      endedAt: new Date(h.now.getTime() - 40 * DAY).toISOString(),
    });
    await h.tickAt(0);
    expect(h.missions.get(TENANT, m.id)).toBeNull();
    // No runtime (revoked or not active): its log cannot be reached, so its row stays too.
    expect(h.missions.get("t2", other.id)).not.toBeNull();
  });
});
