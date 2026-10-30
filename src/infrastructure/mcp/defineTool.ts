import type {
  CallToolResult,
  ContentBlock,
  McpServer,
  RegisteredTool,
  ToolCallback,
} from "@modelcontextprotocol/server";
import type { z } from "zod";
import type { Config } from "../../config.js";
import {
  InvalidInputError,
  MediaStalledError,
  UnsupportedEngineError,
  WahaAuthError,
  WahaNotFoundError,
  WahaUnavailableError,
} from "../../domain/errors.js";
import type { EngineMapper } from "../../domain/message.js";
import type { WahaGateway } from "../../domain/ports/WahaGateway.js";
import { MEDIA_IDLE_TIMEOUT_MS } from "../media/resolveMedia.js";
import type { SignedLinks } from "../media/signedLink.js";

export interface ToolRunContext {
  gateway: WahaGateway;
  mapper: EngineMapper;
  config: Config;
  links: SignedLinks;
  /** Idle timeout for media bodies read by `get_media`. */
  mediaIdleTimeoutMs: number;
}

/** A tool returns text plus structured data, or (only `get_media`) raw content blocks. */
export type ToolOutput<Data> = { text: string; data: Data } | { content: ContentBlock[] };

/**
 * Contract shared by every read-only tool (adapted from bsale-mcp). `run` gets
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
  logger?: Logger;
}

export const MESSAGES = {
  auth: "WAHA rejected the server's API key — check WAHA_API_KEY.",
  unavailable: "WAHA is not reachable right now.",
  notFound: "Group or message not found.",
  unexpected: "Unexpected error while talking to WAHA. Try again later.",
} as const;

function describeError(error: unknown): { message: string; unexpected: boolean } {
  if (error instanceof WahaAuthError) return { message: MESSAGES.auth, unexpected: false };
  // Checked before WahaUnavailableError (its parent): a stalled transfer is a failure
  // worth its own message, not "gone" (the file may still exist on WAHA).
  if (error instanceof MediaStalledError) return { message: error.message, unexpected: false };
  if (error instanceof WahaUnavailableError)
    return { message: MESSAGES.unavailable, unexpected: false };
  if (error instanceof WahaNotFoundError) return { message: MESSAGES.notFound, unexpected: false };
  // These two carry messages written to be shown (no key, no URL).
  if (error instanceof UnsupportedEngineError || error instanceof InvalidInputError)
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
      });
      logger.info(`tool=${def.name} ms=${Date.now() - start} result=ok`);
      if ("content" in out) return { content: out.content };
      const structuredContent = def.outputSchema
        ? (def.outputSchema.parse(out.data) as Record<string, unknown>)
        : undefined;
      return { content: [{ type: "text", text: out.text }], structuredContent };
    } catch (error) {
      const { message, unexpected } = describeError(error);
      const name = error instanceof Error ? error.name : "UnknownError";
      logger.info(`tool=${def.name} ms=${Date.now() - start} result=${name}`);
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

/** Registers `def` with `readOnlyHint: true` and the shared error handling. */
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
      annotations: { readOnlyHint: true },
    },
    // Same runtime type; TypeScript cannot reduce the generic Standard Schema
    // inference to `z.output<InputSchema>` (see bsale-mcp's defineTool).
    createToolHandler(def, deps) as unknown as ToolCallback<InputSchema>,
  );
}
