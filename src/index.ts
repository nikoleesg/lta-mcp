import { createMcpHandler } from "@modelcontextprotocol/server";

import type { Env } from "./env.js";
import { buildServer } from "./server.js";

/**
 * Fails closed: a missing MCP_SHARED_SECRET is a deployment misconfiguration
 * (500), not an open gate. Every protocol request must present it — there's
 * no unauthenticated path into this Worker's MCP handler.
 */
function checkSharedSecret(request: Request, env: Env): Response | null {
  if (!env.MCP_SHARED_SECRET) {
    return new Response("Server misconfigured: MCP_SHARED_SECRET is not set.", { status: 500 });
  }
  const header = request.headers.get("Authorization");
  if (header === `Bearer ${env.MCP_SHARED_SECRET}`) return null;
  return new Response("Unauthorized", { status: 401 });
}

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

    const unauthorized = checkSharedSecret(request, env);
    if (unauthorized) return unauthorized;

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
