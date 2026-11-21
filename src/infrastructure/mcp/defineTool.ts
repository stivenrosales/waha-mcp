import type {
  CallToolResult,
  ContentBlock,
  McpServer,
  RegisteredTool,
  ToolAnnotations,
  ToolCallback,
} from "@modelcontextprotocol/server";
import type { z } from "zod";
import type { MessageActions } from "../../application/messageActions.js";
import type { MissionService } from "../../application/missions/service.js";
import type { ScheduleService } from "../../application/schedules/service.js";
import type { TenantAdmin } from "../../application/tenantAdmin.js";
import {
  DISABLED_TRANSCRIPTION,
  type TranscriptionService,
} from "../../application/transcripts.js";
import type { Config } from "../../config.js";
import {
  InvalidInputError,
  MediaSendUnsupportedError,
  MediaStalledError,
  SendOutcomeUnknownError,
  TranscriptionError,
  UnsupportedEngineError,
  WahaAuthError,
  WahaNotFoundError,
  WahaUnavailableError,
  WhatsAppDisconnectedError,
} from "../../domain/errors.js";
import type { EngineMapper } from "../../domain/message.js";
import type { UploadStore } from "../../domain/ports/UploadStore.js";
import type { WahaGateway } from "../../domain/ports/WahaGateway.js";
import type { WhatsAppSender } from "../../domain/ports/WhatsAppSender.js";
import { MEDIA_IDLE_TIMEOUT_MS } from "../media/resolveMedia.js";
import type { SignedLinks } from "../media/signedLink.js";

export interface ToolRunContext {
  gateway: WahaGateway;
  mapper: EngineMapper;
  config: Config;
  links: SignedLinks;
  /** Idle timeout for media bodies read by `get_media`. */
  mediaIdleTimeoutMs: number;
  /** Voice-note transcription; the disabled service when TRANSCRIPTION_* is not configured. */
  transcription: TranscriptionService;
  sender: WhatsAppSender;
  uploads: UploadStore;
  /** Signs `/upload/:token` links. */
  uploadLinks: SignedLinks;
  /** Tenant management; null for tenants that are not the admin. */
  admin: TenantAdmin | null;
  /** This tenant's missions; null when the server has no `config.missions`. */
  missions: MissionService | null;
  /** This tenant's scheduled messages; null when the server has no `config.missions`. */
  schedules: ScheduleService | null;
  /** This tenant's stored edits, revokes, reactions and poll votes. */
  messageActions: MessageActions;
}

/** A tool returns text plus structured data, or (only `get_media`) raw content blocks. */
export type ToolOutput<Data> = { text: string; data: Data } | { content: ContentBlock[] };

/**
 * Contract shared by every tool (adapted from bsale-mcp). `run` gets
 * the input already validated by `inputSchema`; it may throw domain errors,
 * which `createToolHandler` turns into safe messages. Tools that return raw
 * content blocks declare no `outputSchema`.
 */
export interface ToolDefinition<
  InputSchema extends z.ZodType = z.ZodType,
  OutputSchema extends z.ZodType = z.ZodType,
> {
  name: string;
  title: string;
  description: string;
  inputSchema: InputSchema;
  outputSchema?: OutputSchema;
  /** Default `{ readOnlyHint: true }`; write tools use `SEND_ANNOTATIONS`. */
  annotations?: ToolAnnotations;
  run(
    input: z.output<InputSchema>,
    ctx: ToolRunContext,
  ): Promise<ToolOutput<z.input<OutputSchema>>>;
}

/** One line per tool call: name, duration and outcome. Never arguments, data or secrets. */
export interface Logger {
  info(message: string): void;
}

export interface ToolDeps {
  gateway: WahaGateway;
  /** Cached engine mapper lookup (see `createEngineResolver`). */
  mapper: () => Promise<EngineMapper>;
  config: Config;
  links: SignedLinks;
  /** Default `MEDIA_IDLE_TIMEOUT_MS` (30 s); injectable for tests. */
  mediaIdleTimeoutMs?: number;
  /** Default: transcription off. */
  transcription?: TranscriptionService;
  sender: WhatsAppSender;
  uploads: UploadStore;
  uploadLinks: SignedLinks;
  /** Default null: admin tools then fail with a clear error. */
  admin?: TenantAdmin | null;
  /** Default null: mission tools then answer that missions are not configured. */
  missions?: MissionService | null;
  /** Default null: schedule tools then answer that missions are not configured. */
  schedules?: ScheduleService | null;
  messageActions: MessageActions;
  logger?: Logger;
  /** Told about every call once it ends (usage accounting); a throw is logged, never surfaced. */
  onToolCall?: (call: ToolCallRecord) => void;
}

/** What usage accounting learns about a call: never its arguments or its result. */
export interface ToolCallRecord {
  tool: string;
  /** "ok", or the name of the error the call ended with. */
  outcome: string;
  ms: number;
}

/** Writes to WhatsApp: clients ask the owner to approve every call. */
export const SEND_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

/** Irreversible WhatsApp writes (delete): repeating one changes nothing more. */
export const DESTRUCTIVE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
};

/** Writes to WhatsApp that overwrite a state (edit, react, pin): repeating is harmless. */
export const IDEMPOTENT_WRITE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

export const MESSAGES = {
  auth: "WAHA rejected the server's API key — check WAHA_API_KEY.",
  unavailable: "WAHA is not reachable right now.",
  notFound: "Chat or message not found.",
  unexpected: "Unexpected error while talking to WAHA. Try again later.",
} as const;

/** The user-facing message for a tenant whose WhatsApp session is not `WORKING`. */
export const disconnectedMessage = (publicBaseUrl: string): string =>
  `WhatsApp is disconnected for this account. Re-pair at ${publicBaseUrl.replace(/\/+$/, "")}/pair.`;

function describeError(
  error: unknown,
  config: Pick<Config, "publicBaseUrl">,
): { message: string; unexpected: boolean } {
  if (error instanceof WahaAuthError) return { message: MESSAGES.auth, unexpected: false };
  if (error instanceof WhatsAppDisconnectedError)
    return { message: disconnectedMessage(config.publicBaseUrl), unexpected: false };
  // Checked before WahaUnavailableError (its parent): a stalled transfer is a failure
  // worth its own message, not "gone" (the file may still exist on WAHA).
  if (error instanceof MediaStalledError) return { message: error.message, unexpected: false };
  if (error instanceof WahaUnavailableError)
    return { message: MESSAGES.unavailable, unexpected: false };
  if (error instanceof WahaNotFoundError) return { message: MESSAGES.notFound, unexpected: false };
  // These carry messages written to be shown (no key, no URL).
  if (
    error instanceof UnsupportedEngineError ||
    error instanceof InvalidInputError ||
    error instanceof TranscriptionError ||
    error instanceof SendOutcomeUnknownError ||
    error instanceof MediaSendUnsupportedError
  )
    return { message: error.message, unexpected: false };
  return { message: MESSAGES.unexpected, unexpected: true };
}

/**
 * Runs `def` and never throws to the MCP client: domain errors become their
 * fixed message with `isError: true`; anything else is logged with its stack
 * (server side only) and answered with a generic message.
 */
export function createToolHandler<InputSchema extends z.ZodType, OutputSchema extends z.ZodType>(
  def: ToolDefinition<InputSchema, OutputSchema>,
  deps: ToolDeps,
): (input: z.output<InputSchema>) => Promise<CallToolResult> {
  const logger = deps.logger ?? { info: () => {} };
  const report = (outcome: string, ms: number): void => {
    try {
      deps.onToolCall?.({ tool: def.name, outcome, ms });
    } catch {
      logger.info(`tool=${def.name} usage not recorded`);
    }
  };
  /** Unseen mission outcomes, told once on a successful result; never fails the call. */
  const missionNotice = (): string | null => {
    try {
      return deps.missions?.takeUnseenNotice() ?? null;
    } catch {
      logger.info(`tool=${def.name} mission notice unavailable`);
      return null;
    }
  };
  return async (input) => {
    const start = Date.now();
    try {
      const mapper = await deps.mapper();
      const out = await def.run(input, {
        gateway: deps.gateway,
        mapper,
        config: deps.config,
        links: deps.links,
        mediaIdleTimeoutMs: deps.mediaIdleTimeoutMs ?? MEDIA_IDLE_TIMEOUT_MS,
        transcription: deps.transcription ?? DISABLED_TRANSCRIPTION,
        sender: deps.sender,
        uploads: deps.uploads,
        uploadLinks: deps.uploadLinks,
        admin: deps.admin ?? null,
        missions: deps.missions ?? null,
        schedules: deps.schedules ?? null,
        messageActions: deps.messageActions,
      });
      const ms = Date.now() - start;
      logger.info(`tool=${def.name} ms=${ms} result=ok`);
      if ("content" in out) {
        report("ok", ms);
        const notice = missionNotice();
        return {
          content: notice
            ? [...out.content, { type: "text", text: notice.trimStart() }]
            : out.content,
        };
      }
      const structuredContent = def.outputSchema
        ? (def.outputSchema.parse(out.data) as Record<string, unknown>)
        : undefined;
      // After the output check, so a call that fails it is counted once, as an error.
      report("ok", ms);
      return {
        content: [{ type: "text", text: `${out.text}${missionNotice() ?? ""}` }],
        structuredContent,
      };
    } catch (error) {
      const { message, unexpected } = describeError(error, deps.config);
      const name = error instanceof Error ? error.name : "UnknownError";
      const ms = Date.now() - start;
      logger.info(`tool=${def.name} ms=${ms} result=${name}`);
      report(name, ms);
      if (unexpected)
        logger.info(
          error instanceof Error
            ? `tool=${def.name} error stack:\n${error.stack}`
            : `tool=${def.name} error raw=${String(error)}`,
        );
      return { isError: true, content: [{ type: "text", text: message }] };
    }
  };
}

/** Registers `def` with its annotations (read-only by default) and the shared error handling. */
export function toMcpTool<InputSchema extends z.ZodType, OutputSchema extends z.ZodType>(
  server: McpServer,
  def: ToolDefinition<InputSchema, OutputSchema>,
  deps: ToolDeps,
): RegisteredTool {
  return server.registerTool<OutputSchema, InputSchema>(
    def.name,
    {
      title: def.title,
      description: def.description,
      inputSchema: def.inputSchema,
      ...(def.outputSchema ? { outputSchema: def.outputSchema } : {}),
      annotations: def.annotations ?? { readOnlyHint: true },
    },
    // Same runtime type; TypeScript cannot reduce the generic Standard Schema
    // inference to `z.output<InputSchema>` (see bsale-mcp's defineTool).
    createToolHandler(def, deps) as unknown as ToolCallback<InputSchema>,
  );
}
