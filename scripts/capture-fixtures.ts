/**
 * Dev-only: captures GOWS payloads from a live WAHA, scrubs them and writes
 * them as test fixtures. Read-only (GET only). Usage:
 *   pnpm capture -- --group <id> [--group <id>] [--out <dir>]
 * The WAHA URL and API key are never printed.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { createWahaHttpGateway } from "../src/infrastructure/waha/WahaHttpGateway.js";
import {
  type CaptureArgs,
  fixtureFileName,
  MESSAGE_KINDS,
  type MessageBucket,
  parseCaptureArgs,
  selectMessages,
} from "./capture-lib.js";
import { scrubFixture } from "./scrub.js";

const PAGE_SIZE = 100;
const MAX_PAGES = 5;
const PER_KIND = 2;
const MAX_GROUPS_SAVED = 20;
const TIMEOUT_MS = 60_000;

const BUCKETS: MessageBucket[] = ["messages-text", "messages-media", "messages-misc"];

function idOf(message: unknown): string | undefined {
  const id = (message as { id?: unknown } | null)?.id;
  return typeof id === "string" ? id : undefined;
}

async function main(args: CaptureArgs): Promise<void> {
  const config = loadConfig(process.env);
  const base = config.wahaApiUrl;
  const session = encodeURIComponent(config.wahaSession);
  const gateway = createWahaHttpGateway({
    baseUrl: base,
    apiKey: config.wahaApiKey,
    session: config.wahaSession,
    timeoutMs: TIMEOUT_MS,
  });

  /** GET-only helper for the downloadMedia=true variants the gateway does not expose. */
  async function getJson(pathAndQuery: string): Promise<unknown> {
    const res = await fetch(`${base}${pathAndQuery}`, {
      method: "GET",
      redirect: "error",
      headers: { "X-Api-Key": config.wahaApiKey },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`WAHA responded with status ${res.status}.`);
    return res.json();
  }

  const messagesPath = (chatId: string, offset: number) =>
    `/api/${session}/chats/${encodeURIComponent(chatId)}/messages?${new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String(offset),
      downloadMedia: "true",
    })}`;

  await mkdir(args.out, { recursive: true });
  const write = async (name: string, value: unknown, download = false) => {
    await writeFile(
      join(args.out, fixtureFileName(name, download)),
      `${JSON.stringify(scrubFixture(value), null, 2)}\n`,
    );
  };

  await write("session", await gateway.getSession());
  const groups = await gateway.listGroups();
  await write("groups", groups.slice(0, MAX_GROUPS_SAVED));
  await write("group", await gateway.getGroup(args.groups[0] as string));

  const pages: { chatId: string; messages: unknown[] }[] = [];
  for (const chatId of args.groups) {
    for (let page = 0; page < MAX_PAGES; page++) {
      const messages = await gateway.getMessages(chatId, {
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      });
      pages.push({ chatId, messages });
      if (messages.length < PAGE_SIZE) break;
    }
  }

  const all = pages.flatMap((p) => p.messages);
  const selection = selectMessages(all, PER_KIND);
  for (const bucket of BUCKETS) await write(bucket, selection.byBucket[bucket]);

  // Same messages again, but with media downloaded (WAHA fills `media.url`).
  const keptIds = new Set(selection.selected.map(idOf).filter((id) => id !== undefined));
  const downloaded: unknown[] = [];
  for (const { chatId, messages } of pages) {
    const offsets = [...new Set(messages.map((_, i) => Math.floor(i / PAGE_SIZE) * PAGE_SIZE))];
    for (const offset of offsets) {
      const page = await getJson(messagesPath(chatId, offset));
      if (Array.isArray(page)) downloaded.push(...page.filter((m) => keptIds.has(idOf(m) ?? "")));
    }
  }
  const downloadedSelection = selectMessages(downloaded, Number.POSITIVE_INFINITY);
  for (const bucket of BUCKETS) {
    await write(bucket, downloadedSelection.byBucket[bucket], true);
  }

  // One single-message sample with downloadMedia=true, from a media message.
  let singleSaved = false;
  for (const { chatId, messages } of pages) {
    const media = selectMessages(messages, 1).byBucket["messages-media"][0];
    const id = idOf(media);
    if (id === undefined) continue;
    const single = await getJson(
      `/api/${session}/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(id)}?downloadMedia=true`,
    );
    await write("message-single", single, true);
    singleSaved = true;
    break;
  }

  console.log(`Captured ${all.length} messages from ${args.groups.length} group(s).`);
  console.log(`Kept ${selection.selected.length} samples (up to ${PER_KIND} per kind).`);
  console.log(`Kinds found:   ${selection.found.join(", ") || "none"}`);
  console.log(`Kinds missing: ${selection.missing.join(", ") || "none"}`);
  console.log(`Single-message sample: ${singleSaved ? "saved" : "no media message found"}`);
  console.log(`Total kinds tracked: ${MESSAGE_KINDS.length}. Files written to ${args.out}.`);
}

try {
  await main(parseCaptureArgs(process.argv.slice(2)));
} catch (err) {
  // Print only the message: gateway errors use fixed texts, never the URL or key.
  const message = err instanceof Error ? err.message : "Unknown error.";
  console.error(`capture failed: ${message}`);
  process.exitCode = 1;
}
