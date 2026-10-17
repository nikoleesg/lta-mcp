import { createMcpHandler } from "@modelcontextprotocol/server";

import type { Env } from "./env.js";
import { buildServer } from "./server.js";

/** A plain browser tab hitting the base URL, as opposed to an MCP client's GET (which asks for text/event-stream). */
function isBrowserNavigation(request: Request): boolean {
  return request.method === "GET" && (request.headers.get("Accept") ?? "").includes("text/html");
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    // No /mcp suffix — the whole Worker is the MCP endpoint, so the connect
    // URL is just the deployment's base URL. The transport itself doesn't
    // care about the request path, only method/headers/body.
    if (isBrowserNavigation(request)) {
      return new Response("lta-mcp is running. Point your MCP client at this base URL.\n", {
        status: 200,
        headers: { "Content-Type": "text/plain" }
      });
    }

    // No auth check here: the Worker sits behind a Cloudflare Access
    // application, which authenticates every request at the edge before it
    // reaches this handler. See README "Access control".

    // A fresh handler (and fresh McpServer, via buildServer) per request keeps
    // this Worker fully stateless — no session affinity, safe to run on any
    // isolate. `legacy: "stateless"` is already createMcpHandler's default;
    // it's spelled out here so a future 2026-07-28-native client and an
    // older 2025 streamable-HTTP client (e.g. a gateway that hasn't upgraded)
    // both get served without session state.
    const handler = createMcpHandler(() => buildServer(env), { legacy: "stateless" });
    return handler.fetch(request);
  }
} satisfies ExportedHandler<Env>;
