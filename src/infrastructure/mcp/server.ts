import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import type { Config } from "../../config.js";
import type { WahaGateway } from "../../domain/ports/WahaGateway.js";
import type { AuthInfo } from "../auth/bearer.js";
import { ICON_DATA_URI } from "../http/icon.js";
import type { SignedLinks } from "../media/signedLink.js";
import { createEngineResolver } from "../waha/engines/index.js";
import { type Logger, type ToolDefinition, toMcpTool } from "./defineTool.js";
import { registerPrompts } from "./prompts.js";

const SERVER_NAME = "waha-mcp";
const SERVER_VERSION = "0.1.0";

export interface CreateMcpServerOptions {
  tools: ReadonlyArray<ToolDefinition>;
  instructions: string;
  gateway: WahaGateway;
  config: Config;
  links: SignedLinks;
  /** Idle timeout for media bodies (default 30 s); injectable for tests. */
  mediaIdleTimeoutMs?: number;
  logger?: Logger;
}

export interface McpServerHandle {
  handler(req: Request, opts: { authInfo: AuthInfo }): Promise<Response>;
}

const bearerToken = (req: Request): string =>
  /^Bearer[ ]+(\S+)/i.exec(req.headers.get("authorization") ?? "")?.[1] ?? "";

/**
 * Stateless MCP over Streamable HTTP: `createMcpHandler` builds a fresh
 * `McpServer` per request (no shared transport state, as in bsale-mcp). The
 * engine mapper lookup is shared across requests, so `getSession()` runs once.
 */
export function createMcpServer(options: CreateMcpServerOptions): McpServerHandle {
  const { tools, instructions, gateway, config, links, logger, mediaIdleTimeoutMs } = options;
  const mapper = createEngineResolver(gateway);

  const http = createMcpHandler(() => {
    const server = new McpServer(
      {
        name: SERVER_NAME,
        version: SERVER_VERSION,
        icons: [{ src: ICON_DATA_URI, mimeType: "image/svg+xml", sizes: ["any"] }],
      },
      { instructions },
    );
    for (const tool of tools)
      toMcpTool(server, tool, { gateway, mapper, config, links, logger, mediaIdleTimeoutMs });
    registerPrompts(server, { timezone: config.timezone });
    return server;
  });

  return {
    handler: (req, { authInfo }) =>
      http.fetch(req, {
        authInfo: {
          token: bearerToken(req),
          clientId: authInfo.clientId,
          scopes: authInfo.scope.split(" ").filter(Boolean),
        },
      }),
  };
}
