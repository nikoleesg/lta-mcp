import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import type { Env } from "../env.js";
import { busArrivalLta, sgtClock, type BusArrivalResult } from "../lta/busArrival.js";

const BusArrivalInputSchema = z.object({
  busStopCode: z
    .string()
    .regex(/^\d{5}$/, "Bus stop code must be exactly 5 digits, e.g. \"83139\"")
    .describe("The stop's 5-digit LTA bus stop code, e.g. \"83139\". Not a stop name — resolve a name or address to a code first"),
  serviceNo: z
    .string()
    .optional()
    .describe("Optional bus service number to narrow the result to one service, e.g. \"15\", \"150\" or \"225G\". A string, not a number: some loop services carry a G/W direction suffix. Omit to get every service at the stop"),
  responseFormat: z
    .enum(["markdown", "json"])
    .default("markdown")
    .describe("'markdown' for a human-readable list, 'json' for machine-readable structured data")
});

type BusArrivalInput = z.infer<typeof BusArrivalInputSchema>;

const ArrivalSchema = z.object({
  estimatedArrival: z.string(),
  minutesAway: z.number(),
  monitored: z.boolean(),
  load: z.string(),
  type: z.string(),
  wheelchairAccessible: z.boolean(),
  originCode: z.string(),
  destinationCode: z.string(),
  visitNumber: z.number(),
  latitude: z.number().optional(),
  longitude: z.number().optional()
});

const BusArrivalOutputSchema = z.object({
  busStopCode: z.string(),
  retrievedAt: z.string(),
  services: z.array(
    z.object({
      serviceNo: z.string(),
      operator: z.string(),
      arrivals: z.array(ArrivalSchema)
    })
  )
});

function formatMarkdown(output: BusArrivalResult, serviceNo: string | undefined): string {
  const heading = `# Bus arrivals at stop ${output.busStopCode}`;

  // An empty Services array is the documented "no buses in service" response,
  // not a failure — say what it means rather than showing an empty page.
  if (output.services.length === 0) {
    const what = serviceNo ? `service ${serviceNo} at this stop` : "this stop";
    return [
      heading,
      "",
      `No arrival data is available for ${what} right now.`,
      "",
      "LTA only publishes arrivals while buses are on the roads, so this usually means the service has finished for the night or has not started yet. Less often, the feed is briefly unavailable. It can also mean the stop or service code is wrong.",
      serviceNo ? "\nTo check whether the stop itself is live, call again without `serviceNo`." : ""
    ]
      .join("\n")
      .trimEnd();
  }

  const lines: string[] = [
    heading,
    "",
    `Live as of ${sgtClock(output.retrievedAt)} SST (UTC+8). "0 min" means arriving now.`,
    ""
  ];

  for (const service of output.services) {
    lines.push(`## ${service.serviceNo} — ${service.operator}`);
    for (const arrival of service.arrivals) {
      const details = [arrival.load.toLowerCase(), arrival.type.toLowerCase()];
      if (arrival.wheelchairAccessible) details.push("wheelchair accessible");
      if (!arrival.monitored) details.push("scheduled, not live-tracked");
      lines.push(
        `- **${arrival.minutesAway} min** (${sgtClock(arrival.estimatedArrival)}) — ${details.join(" · ")}`
      );
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

function handleApiError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Error: LTA DataMall bus arrival lookup failed — ${message}. Check that the LTA_ACCOUNT_KEY secret is set and valid, and that busStopCode is a real 5-digit stop code.`;
}

export function registerBusArrivalTool(server: McpServer, env: Env): void {
  server.registerTool(
    "bus_arrival",
    {
      title: "Bus Arrival",
      description: `Live arrival times for buses at a Singapore bus stop, from LTA DataMall's real-time Bus Arrival API (refreshed every 20 seconds).

Returns up to the next 3 oncoming buses for every service at the stop — or for one service if \`serviceNo\` is given — with minutes until arrival, how crowded each bus is, and whether it is wheelchair accessible.

Takes a 5-digit bus stop **code**, not a stop name. If you only have a name, address or coordinates, resolve it first (OneMap's \`nearby_transport\` returns bus stops with their codes).

Two details worth reading off the result:
  - \`minutesAway\` is rounded down to the whole minute, per LTA's display guidance; \`0\` means the bus is arriving now (or is a moment overdue).
  - \`monitored: false\` means the time is the operator's published schedule rather than an estimate from the bus's live position, so it can shift. Coordinates are returned only for live-tracked buses.

An empty \`services\` list is a normal answer, not an error: LTA publishes arrivals only while buses are on the roads, so a stop after the last bus returns nothing at all.

Args:
  - busStopCode (string, required): the stop's 5-digit LTA code, e.g. "83139"
  - serviceNo (string, optional): narrow to one service, e.g. "15" or "225G"
  - responseFormat ('markdown' | 'json', default 'markdown'): output format

Returns:
  {
    "busStopCode": string,
    "retrievedAt": string,   // ISO 8601 +08:00, the baseline minutesAway counts from
    "services": [{
      "serviceNo": string,
      "operator": string,    // e.g. "SBS Transit", "Go-Ahead Singapore"
      "arrivals": [{
        "estimatedArrival": string,      // ISO 8601 +08:00
        "minutesAway": number,
        "monitored": boolean,            // false = schedule-based, may shift
        "load": string,                  // "Seats available" | "Standing available" | "Limited standing"
        "type": string,                  // "Single deck" | "Double deck" | "Bendy"
        "wheelchairAccessible": boolean,
        "originCode": string, "destinationCode": string,
        "visitNumber": number,
        "latitude"?: number, "longitude"?: number   // live-tracked buses only
      }]
    }]
  }

Examples:
  - Use when: "When is the next bus at stop 83139?" -> busStopCode="83139"
  - Use when: "How long until bus 15 gets to Opp Bedok Stn?" -> resolve the stop to a code, then busStopCode=<code>, serviceNo="15"
  - Use when: "Is the next 154 crowded / wheelchair accessible?" -> read \`load\` and \`wheelchairAccessible\`
  - Don't use when: you need timetables, route paths or the stops along a service — this is live arrivals only`,
      inputSchema: BusArrivalInputSchema,
      outputSchema: BusArrivalOutputSchema,
      annotations: {
        title: "Bus Arrival",
        readOnlyHint: true,
        destructiveHint: false,
        // Live data: the same call a minute later legitimately returns different times.
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async (params: BusArrivalInput) => {
      try {
        if (!env.LTA_ACCOUNT_KEY) {
          return {
            isError: true,
            content: [{
              type: "text",
              text: "Error: LTA_ACCOUNT_KEY is not configured on this deployment — refusing to call DataMall. Set it with `wrangler secret put LTA_ACCOUNT_KEY`."
            }]
          };
        }

        const structuredContent: BusArrivalResult = await busArrivalLta(
          { busStopCode: params.busStopCode, serviceNo: params.serviceNo },
          env.LTA_ACCOUNT_KEY
        );

        const text =
          params.responseFormat === "json"
            ? JSON.stringify(structuredContent, null, 2)
            : formatMarkdown(structuredContent, params.serviceNo);

        return {
          content: [{ type: "text", text }],
          structuredContent
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: handleApiError(error) }]
        };
      }
    }
  );
}
