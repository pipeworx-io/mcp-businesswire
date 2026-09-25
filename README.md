# @pipeworx/businesswire

Live press releases from Business Wire's all-news RSS channel — headline,
dateline, publish time, excerpt and Business Wire's own release id, newest
first, across roughly the last seven days of the whole wire.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1683+ live data sources.

## Tools

- `businesswire_latest_releases(since_hours?, limit?)` — the newest releases
  in the current window (up to 100 per call). `newest_item_at` and
  `oldest_item_at` tell a caller how wide the live window is right now.
- `businesswire_search_releases(query, since_hours?, limit?)` — keyword or
  company match over headline, dateline and excerpt across the whole window
  (~3,500 releases measured).
- `businesswire_get_release(url)` — one specific release by the URL or
  `release_id` a prior call returned. Fails clearly (not silently empty) if
  the release has aged out of the window.

## Auth

Keyless. No account, no clickthrough terms.

## Data sources

- <https://feed.businesswire.com/rss/home/?rss=G1QFDERJXkJcFVJYWQ==> — Business
  Wire's all-news channel. Measured 2026-09-22: 3,492 items, oldest
  2026-09-15, newest 2026-09-22, ~4 MB of XML in under half a second.

Every call re-fetches this window live — it is **not** an archive. A release
older than about a week is no longer in it (the tools say so rather than
returning nothing silently).

### Why an earlier probe called this wire dead

The wave-1 press-release probe (fleet #2285) recorded Business Wire as "a
993-byte 200 with an empty items array". Those bytes are a well-formed RSS
envelope with zero items whose channel `<description>` reads *"RSS channel ID
is not available in the request. Please make sure you have a valid RSS
link."* — Business Wire answers a missing or invalid `rss=` token with HTTP
200 and an error written inside the channel (reproduced at 1,001 bytes with
`?rss=bogus`). A status code cannot tell that apart from a quiet feed; this
pack checks for it and reports it as a broken token, not an empty wire.

### Where the feed token comes from

`www.businesswire.com` sits behind Akamai and answers a non-browser
User-Agent with 403 on every path — including its own `robots.txt` and the
RSS index page. `feed.businesswire.com` is a separate host that serves this
pack's own identity (`pipeworx-mcp/1.0`) without complaint, and its
`robots.txt` publishes the all-news token in a `Sitemap:` line. Tokens are
opaque per-channel ids; per-industry channels exist (`G1QFDERJXkJeEFpRVQ==`
is "Communications News") but the index that maps them lives on the blocked
host, so this pack reads the all-news channel only.

### Item shape

Business Wire's items carry no issuer tag. The description opens with the
wire's dateline (`BENGALURU, India--(BUSINESS WIRE)--Rippling, ...`), which
this pack splits into `dateline` and `excerpt`; the issuer usually leads the
excerpt but is not a separate field. Links carry a per-feed `feedref=`
tracking token, stripped into `canonical_url`. `release_id` is the feed's
`<guid>` (e.g. `20260921847964en`).

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "businesswire": {
      "url": "https://gateway.pipeworx.io/businesswire/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/businesswire/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1683+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/businesswire_latest_releases \
  -H 'Content-Type: application/json' \
  -d '{}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/businesswire_latest_releases`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "businesswire": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-businesswire"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-businesswire
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Businesswire data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
