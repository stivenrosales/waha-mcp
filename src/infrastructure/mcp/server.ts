import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import type { TenantAdmin } from "../../application/tenantAdmin.js";
import type { Config } from "../../config.js";
import type { AuthInfo } from "../auth/bearer.js";
import { ICON_DATA_URI } from "../http/icon.js";
import { releaseWhenDone } from "../http/releaseWhenDone.js";
import type { TenantRegistry } from "../tenants/registry.js";
import type { TenantRuntime } from "../tenants/runtime.js";
import { type Logger, type ToolCallRecord, type ToolDefinition, toMcpTool } from "./defineTool.js";
import { ADMIN_INSTRUCTIONS } from "./instructions.js";
import { registerPrompts } from "./prompts.js";

const SERVER_NAME = "waha-mcp";
export const SERVER_VERSION = "0.4.0";

export interface CreateMcpServerOptions {
  tools: ReadonlyArray<ToolDefinition>;
  /** Registered (and their instructions added) only for `role === "admin"`. */
  adminTools: ReadonlyArray<ToolDefinition>;
  instructions: string;
  config: Config;
  registry: Pick<TenantRegistry, "acquire">;
  /** Tenant management handed to admin tools; members get null. */
  admin: TenantAdmin;
  /** Idle timeout for media bodies read by `get_media` (default 30 s); injectable for tests. */
  mediaIdleTimeoutMs?: number;
  logger?: Logger;
  /** Usage accounting: every tool call, attributed to the caller's tenant. */
  recordToolCall?: (tenantId: string, call: ToolCallRecord) => void;
}

export interface McpServerHandle {
  handler(req: Request, opts: { authInfo: AuthInfo }): Promise<Response>;
}

const bearerToken = (req: Request): string =>
  /^Bearer[ ]+(\S+)/i.exec(req.headers.get("authorization") ?? "")?.[1] ?? "";

/** What `handler` hands the factory through `McpRequestContext.authInfo.extra`. */
interface TenantExtra {
  auth: AuthInfo;
  runtime: TenantRuntime;
}

/** Same answer as `bearerGuard` for a token whose tenant cannot be served. */
const invalidToken = (config: Config): Response =>
  Response.json(
    { error: "invalid_token" },
    {
      status: 401,
      headers: {
        "WWW-Authenticate": `Bearer error="invalid_token", resource_metadata="${config.publicBaseUrl}/.well-known/oauth-protected-resource"`,
        "Cache-Control": "no-store",
      },
    },
  );

/**
 * Stateless MCP over Streamable HTTP: `createMcpHandler` builds a fresh `McpServer` per request.
 *
 * `handler` acquires the caller's tenant runtime from the registry (401 `invalid_token` when the
 * tenant cannot be served) and passes it, with the full `AuthInfo`, in the SDK's
 * `authInfo.extra`. The factory reads it from its `McpRequestContext` and registers the tools
 * against that runtime only; admin tools only for the admin role. The runtime is released when
 * the response body ends or is cancelled (tools keep running while an SSE response streams).
 */
export function createMcpServer(options: CreateMcpServerOptions): McpServerHandle {
  const {
    tools,
    adminTools,
    instructions,
    config,
    registry,
    admin,
    logger,
    mediaIdleTimeoutMs,
    recordToolCall,
  } = options;
  const adminInstructions = `${instructions}\n\n${ADMIN_INSTRUCTIONS}`;

  const http = createMcpHandler((ctx) => {
    const extra = ctx.authInfo?.extra as TenantExtra | undefined;
    if (!extra) throw new Error("MCP request without a tenant runtime.");
    const isAdmin = extra.auth.role === "admin";
    const server = new McpServer(
      {
        name: SERVER_NAME,
        version: SERVER_VERSION,
        icons: [{ src: ICON_DATA_URI, mimeType: "image/svg+xml", sizes: ["any"] }],
      },
      { instructions: isAdmin ? adminInstructions : instructions },
    );
    const deps = {
      ...extra.runtime.context,
      mediaIdleTimeoutMs,
      admin: isAdmin ? admin : null,
      logger,
      ...(recordToolCall
        ? { onToolCall: (call: ToolCallRecord) => recordToolCall(extra.auth.tenantId, call) }
        : {}),
    };
    for (const tool of tools) toMcpTool(server, tool, deps);
    if (isAdmin) for (const tool of adminTools) toMcpTool(server, tool, deps);
    registerPrompts(server, { timezone: config.timezone });
    return server;
  });

  return {
    handler: async (req, { authInfo }) => {
      const held = registry.acquire(authInfo.tenantId);
      if (!held) {
        await req.body?.cancel().catch(() => {});
        return invalidToken(config);
      }
      let response: Response;
      try {
        response = await http.fetch(req, {
          authInfo: {
            token: bearerToken(req),
            clientId: authInfo.clientId,
            scopes: authInfo.scope.split(" ").filter(Boolean),
            extra: { auth: authInfo, runtime: held.runtime } satisfies TenantExtra,
          },
        });
      } catch (error) {
        held.release();
        throw error;
      }
      return releaseWhenDone(response, held.release);
    },
  };
}
