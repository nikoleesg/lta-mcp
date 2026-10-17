# lta-mcp

A stateless MCP server on Cloudflare Workers that wraps [LTA DataMall](https://datamall.lta.gov.sg/content/datamall/en.html), the Singapore Land Transport Authority's open data API.

**Scope**: the **Bus Arrival** API (`v3/BusArrival`) — real-time arrival times for every bus service at a given bus stop, refreshed by LTA every 20 seconds. One tool, `bus_arrival`.

DataMall publishes ~33 datasets; the rest (bus routes, taxi availability, carpark availability, train service alerts, traffic incidents, …) are deliberately not wrapped yet. The name is `lta-mcp` rather than `lta-bus-arrival` so those can be added as further tools without renaming the server, its repo, or its Worker.

This server does **not** resolve bus stop names to codes — `bus_arrival` takes a 5-digit stop code. Use [`onemap-mcp`](https://github.com/nikoleesg/onemap-mcp)'s `nearby_transport` to go from an address or coordinates to nearby bus stops and their codes; the two servers compose.

## How it works

- Built on `@modelcontextprotocol/server` v2 (the web-standards TypeScript SDK), using `createMcpHandler` in stateless mode — a fresh `McpServer` is constructed per HTTP request, so the Worker holds no session state and can run on any isolate.
- No `/mcp` path — the Worker's base URL *is* the MCP endpoint. The transport doesn't care about the request path, only method/headers/body, so nothing is mounted under a subpath.
- DataMall authenticates with a **static `AccountKey` header**, not a token exchange. There is nothing to refresh and nothing to cache, so unlike `onemap-mcp` this server needs no KV namespace — the key is read from a Worker secret and forwarded on each call.
- Responses are **not** cached. The upstream data changes every 20 seconds and the whole point of the tool is liveness, so every call is a fresh round trip.
- The Worker does no authentication of its own — it relies on a Cloudflare Access application in front of it (see "Access control").

### What the wrapper adds over the raw API

The raw DataMall response is designed for a bus-app front end, not for a language model. `bus_arrival` normalises it:

| Raw API | This server |
|---|---|
| `EstimatedArrival` timestamp only | plus `minutesAway`, rounded **down** to the whole minute per LTA's display guidance (`0` = arriving now) |
| `NextBus` / `NextBus2` / `NextBus3` objects, always present, blank when there is no such bus | one `arrivals` array with the blank slots dropped |
| `Load: "SEA"`, `Type: "DD"`, `Operator: "GAS"` | decoded to `"Seats available"`, `"Double deck"`, `"Go-Ahead Singapore"` (unknown codes pass through unchanged) |
| `Feature: "WAB"` or `""` | `wheelchairAccessible: true \| false` |
| `Monitored: 0 \| 1` | `monitored: false \| true` — `false` means the time is the operator's schedule, not a live estimate |
| `Latitude`/`Longitude` as strings, `"0.0"` for untracked buses | numbers, and **omitted entirely** unless the bus is live-tracked |
| Services in arbitrary order | sorted numerically, so `15` precedes `150` and `225G`/`225W` stay adjacent |

An empty `services` list is a normal answer rather than an error: LTA only publishes arrivals while buses are on the roads, so a stop queried after the last bus returns nothing at all. The markdown output says so in words instead of rendering an empty page.

## Requirements

- An [LTA DataMall account key](https://datamall.lta.gov.sg/content/datamall/en/request-for-api.html) — request one with the form on that page; LTA emails the key.
- A Cloudflare account with Workers access.
- Node.js 20+ and `npx` for local development.

## Setup

```bash
npm install

# Secret — never committed, set per environment. Required; the tool fails
# closed (errors out) if it is missing.
npx wrangler secret put LTA_ACCOUNT_KEY
```

For local development, copy `.dev.vars.example` to `.dev.vars` and fill in real values (`.dev.vars` is gitignored) — `wrangler dev` reads secrets from there instead of the Cloudflare dashboard.

## Development

```bash
npm run dev         # wrangler dev, serves http://localhost:8787
npm run typecheck   # tsc --noEmit
```

## Deploy

```bash
npm run deploy       # wrangler deploy
```

This deploys to `https://lta-mcp.<your-subdomain>.workers.dev` (or a custom route, if configured in `wrangler.jsonc`) — connect an MCP client directly to that base URL, no path suffix.

`wrangler deploy` builds and ships the current `src/` on every run — there's no separate build step and no versioned release artifact beyond the `version` in `package.json`/`registry.yaml`. Redeploy any time a tool is added or changed to push it live; existing secrets carry over automatically since they're bound to the Worker, not to a specific deploy.

## Tools

### `bus_arrival`

Registered on this server as bare `bus_arrival` (no service prefix), by design — see "Naming" below.

Live arrival times for buses at a Singapore bus stop. Returns up to the next 3 oncoming buses for every service at the stop, or for one service if `serviceNo` is given.

| Param | Type | Default | Description |
|---|---|---|---|
| `busStopCode` | string | — | The stop's 5-digit LTA code, e.g. `"83139"`. A code, not a stop name |
| `serviceNo` | string | — | Optional. Narrow to one service, e.g. `"15"` or `"225G"`. A string, not a number — some loop services carry a `G`/`W` direction suffix |
| `responseFormat` | `"markdown" \| "json"` | `"markdown"` | Output format |

Returns `{ busStopCode, retrievedAt, services: [{ serviceNo, operator, arrivals: [...] }] }`, where each arrival carries `estimatedArrival`, `minutesAway`, `monitored`, `load`, `type`, `wheelchairAccessible`, `originCode`, `destinationCode`, `visitNumber`, and — for live-tracked buses only — `latitude`/`longitude`.

Markdown output looks like:

```markdown
# Bus arrivals at stop 83139

Live as of 23:53 SST (UTC+8). "0 min" means arriving now.

## 15 — Go-Ahead Singapore
- **0 min** (23:54) — limited standing · double deck · wheelchair accessible
- **8 min** (00:02) — standing available · single deck · wheelchair accessible
- **25 min** (00:18) — seats available · single deck · wheelchair accessible

## 150 — SBS Transit
- **11 min** (00:05) — seats available · single deck · wheelchair accessible · scheduled, not live-tracked
```

### Naming

The tool is registered bare — `bus_arrival`, not `lta_bus_arrival` — deliberately, because the ContextForge gateway this server is meant to run behind auto-prefixes tool names with the backend name it is registered under. Registered bare here, it surfaces as `lta_bus_arrival` once wrapped in the gateway, matching MCP's collision-avoidance convention without hardcoding the prefix twice. A client connecting to this Worker directly (bypassing ContextForge) sees the bare name instead.

## Access control

This Worker does no authentication of its own: it is meant to sit behind a [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) self-hosted application, which authenticates every request at Cloudflare's edge before it reaches the Worker. Without one in front of it, the endpoint is open to anyone who finds the URL.

- **Make the Worker itself the Access destination** (Workers & Pages → the Worker → Access → *Protect this Worker behind Access* → **All traffic**, or a self-hosted application whose destination is this Worker). That covers every way in — routes, custom domains, the `*.workers.dev` URL and preview URLs. A hostname-based application covers only the hostnames it lists, so the `*.workers.dev` and preview URLs would stay open unless they're listed too.
- **Machine clients (e.g. the ContextForge gateway)** authenticate with an Access **service token**: add a *Service Auth* policy for it to the application, and the client sends `CF-Access-Client-Id` / `CF-Access-Client-Secret` on every request (see "Client config"). Create the token under Zero Trust → Access → Service credentials → Service Tokens; the secret is shown only once.
- A plain browser visit gets Access's login page; once signed in, it reaches the Worker's friendly status message.

## Client config

This is a remote streamable-HTTP MCP server. Point any MCP client (including the ContextForge gateway) at the deployed base URL — there is no `/mcp` path suffix:

```json
{
  "mcpServers": {
    "lta": {
      "type": "streamable-http",
      "url": "https://lta-mcp.<YOUR_WORKERS_SUBDOMAIN>.workers.dev",
      "headers": {
        "CF-Access-Client-Id": "<CF_ACCESS_CLIENT_ID>",
        "CF-Access-Client-Secret": "<CF_ACCESS_CLIENT_SECRET>"
      }
    }
  }
}
```

The `headers` carry a Cloudflare Access service token — see "Access control" for where to create one. Without them, Access answers with a redirect to its login page instead of forwarding the request. Replace the `url` with your custom domain if the Access application is on one.

## Security notes

- No DataMall key or Cloudflare identifiers are stored in this repo — `LTA_ACCOUNT_KEY` is a Worker secret.
- The Cloudflare Access application is mandatory: the Worker itself accepts any request, so without Access in front of every hostname it answers on, anyone who finds the URL can spend your DataMall quota.
- The account key is only ever sent upstream to `datamall2.mytransport.sg` as the `AccountKey` header; it is never echoed into a tool response or an error message.

## Out of scope

- Resolving stop names/addresses to bus stop codes — use `onemap-mcp`'s `nearby_transport` (see "Scope" above).
- The XML response format (`Accept: application/atom+xml`); this server always requests JSON.
- The other ~32 DataMall datasets. They belong in this server as additional tools when needed — that is why it is named `lta-mcp`.
