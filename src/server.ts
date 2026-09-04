import { McpServer } from "@modelcontextprotocol/server";

import type { Env } from "./env.js";
import { registerBusArrivalTool } from "./tools/busArrival.js";

const SERVER_NAME = "lta-mcp";
const SERVER_VERSION = "0.1.0";

/** Builds a fresh McpServer bound to this request's `env` (secrets). */
export function buildServer(env: Env): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerBusArrivalTool(server, env);
  return server;
}
