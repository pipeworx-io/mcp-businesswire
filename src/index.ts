interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * RSS / Atom item parsing, shared across every pack and worker that reads a
 * feed.
 *
 * Ported from `workers/press-intel/src/feed.ts`, which was itself ported from
 * the working parser in `mcps/us-news-feeds/src/index.ts` — the
 * regex-over-XML shape is deliberate (no DOM in Workers, and every feed in
 * the wild is malformed in some small way that a strict parser would
 * reject). press-intel's version is the hardened one: it was built against
 * 85 live feeds and adds two things the pack-local copies were missing.
 * Moved here 2026-09-21 (fleet #2285) so the press-release wire packs reuse
 * it instead of re-copy-pasting a third parser — a capability proven against
 * 85 feeds belongs in one place, not one worker.
 *
 * 1. `<media:credit role="author">`. ZDNET carries a byline on 20 of 20 items
 *    in that tag and nothing else. The original probe scored ZDNET
 *    `byline_pct: 0` and filed it as needing an article-page fetch — the feed
 *    was fine, the parser was looking in three places out of five.
 *
 * 2. `newestItemAt`. A feed can answer 200 with well-formed XML and still be
 *    abandoned: WSJ Tech's registered feed (feeds.a.dj.com) returns 20 valid
 *    items whose newest is dated 2025-01-27. HTTP status cannot see that,
 *    which is why every caller should record the newest item date per poll
 *    and flag a feed stale rather than trusting a green 200. This is exactly
 *    the trap a keyless press-release wire hits too: a 200 with well-formed
 *    XML and a stale newest item looks identical to a live one at the
 *    transport layer.
 */

interface FeedItem {
  title: string;
  link: string;
  publishedAt?: string;
  excerpt?: string;
  /** RAW byline string, exactly as the feed emitted it. Never normalised here. */
  rawByline?: string;
  guid?: string;
  categories?: string[];
}

interface ParsedFeed {
  items: FeedItem[];
  /** ISO date of the newest item that carried a parseable date, or null. */
  newestItemAt: string | null;
  /** How many items carried any byline at all — the per-poll byline coverage. */
  withByline: number;
}

const AUTHOR_TAGS = ['dc:creator', 'media:credit', 'itunes:author', 'dc:contributor'];

function parseFeed(xml: string): ParsedFeed {
  const items: FeedItem[] = [];
  const blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) ?? [];
  let newest: number | null = null;
  let withByline = 0;

  for (const b of blocks) {
    const link = extractLink(b);
    const publishedRaw = tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date');
    const ts = publishedRaw ? Date.parse(publishedRaw) : NaN;
    if (Number.isFinite(ts) && (newest === null || ts > newest)) newest = ts;
    const rawByline = feedByline(b);
    if (rawByline) withByline++;
    items.push({
      title: clean(tag(b, 'title')),
      link,
      publishedAt: Number.isFinite(ts) ? new Date(ts).toISOString() : undefined,
      excerpt: clean(tag(b, 'description') || tag(b, 'summary') || tag(b, 'content:encoded') || tag(b, 'content'))
        .slice(0, EXCERPT_MAX) || undefined,
      rawByline: rawByline || undefined,
      guid: tag(b, 'guid') || tag(b, 'id') || link || undefined,
      categories: cats(b),
    });
  }

  return {
    items,
    newestItemAt: newest === null ? null : new Date(newest).toISOString(),
    withByline,
  };
}

/**
 * Excerpt cap.
 *
 * `docs/journalist-db-plan.md` draws a rights boundary: URL + metadata + our own
 * summary + a SHORT excerpt, no full-text retention. Several feeds put the
 * entire article in `<content:encoded>` (The Register does), so without a
 * hard cut here "store the excerpt" quietly becomes "mirror the publisher's
 * archive" — of publishers we intend to pitch, or in the wire case, of
 * publishers whose own release text this is.
 */
const EXCERPT_MAX = 400;

function feedByline(b: string): string {
  for (const t of AUTHOR_TAGS) {
    const v = clean(tag(b, t));
    if (v) return v;
  }
  return clean(authorName(b));
}

function extractLink(b: string): string {
  const rss = b.match(/<link>([\s\S]*?)<\/link>/i);
  if (rss && rss[1].trim()) return clean(rss[1]);
  const alt =
    b.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i) ||
    b.match(/<link[^>]*href=["']([^"']+)["']/i);
  return alt ? decodeXml(alt[1].trim()) : '';
}

function authorName(b: string): string {
  const a = b.match(/<author[\s>]([\s\S]*?)<\/author>/i);
  if (!a) return '';
  const name = a[1].match(/<name>([\s\S]*?)<\/name>/i);
  if (name) return name[1];
  // RSS 2.0 <author> is an email address, optionally "a@b.com (Real Name)".
  const emailWithName = a[1].match(/\(([^)]{2,80})\)/);
  if (emailWithName) return emailWithName[1];
  return /@/.test(a[1]) ? '' : a[1];
}

function cats(b: string): string[] | undefined {
  const list: string[] = [];
  for (const m of b.matchAll(/<category[^>]*?(?:term=["']([^"']+)["'][^>]*)?>([\s\S]*?)<\/category>/gi)) {
    const v = clean(m[1] || m[2]);
    if (v) list.push(v);
  }
  for (const m of b.matchAll(/<category[^>]*term=["']([^"']+)["'][^>]*\/>/gi)) list.push(decodeXml(m[1]));
  return list.length ? [...new Set(list)].slice(0, 10) : undefined;
}

function tag(xml: string, name: string): string {
  const esc = name.replace(':', '\\:');
  const m = xml.match(new RegExp(`<${esc}[^>]*>([\\s\\S]*?)<\\/${esc}>`, 'i'));
  return m ? unwrap(m[1]) : '';
}

function unwrap(s: string): string {
  const m = s.trim().match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  return (m ? m[1] : s).trim();
}

function decodeXml(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function clean(s: unknown): string {
  if (typeof s !== 'string') return '';
  return decodeXml(
    s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<\/?[a-zA-Z][^>]*>/g, ' '),
  )
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Split feed XML into raw `<item>`/`<entry>` blocks, in document order — the
 * same blocks {@link parseFeed} iterates internally.
 *
 * Exposed so a caller can read a VENDOR-SPECIFIC field {@link parseFeed} does
 * not know about — GlobeNewswire's `dc:contributor` issuer name, PRNewswire's
 * `prn:industry` list — by zipping this array against `parseFeed(xml).items`;
 * both walk the same blocks in the same order, so index N in one is index N
 * in the other. Added for the press-release wire packs (fleet #2285): those
 * feeds carry the issuer in a tag `parseFeed`'s generic byline heuristic
 * would mis-attribute (PRNewswire's `<media:credit>` names the WIRE, "PR
 * Newswire", not the issuer).
 */
function feedItemBlocks(xml: string): string[] {
  return xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) ?? [];
}

/**
 * Read one XML tag's text out of a raw item/entry block (CDATA-unwrapped,
 * entity-decoded). Exposed alongside {@link feedItemBlocks} for the same
 * reason.
 */
function feedTag(block: string, name: string): string {
  return tag(block, name);
}

/**
 * Like {@link feedTag}, but returns every occurrence — for a tag a feed
 * repeats per item (PRNewswire's `<prn:industry>`, one element per industry
 * assigned to the release).
 */
function feedTagAll(block: string, name: string): string[] {
  const esc = name.replace(':', '\\:');
  const re = new RegExp(`<${esc}[^>]*>([\\s\\S]*?)<\\/${esc}>`, 'gi');
  const out: string[] = [];
  for (const m of block.matchAll(re)) {
    const v = clean(unwrap(m[1]));
    if (v) out.push(v);
  }
  return out;
}

/**
 * Canonical URL for dedupe.
 *
 * Strips tracking noise and the per-feed `?mod=` / `utm_*` suffixes that make
 * the same article arrive as two rows from a section feed and a topic feed.
 * Deliberately keeps the path and any non-tracking query, because several
 * sources address articles by query string alone.
 */
function canonicalUrl(raw: string): string | null {
  const t = (raw || '').trim();
  if (!/^https?:\/\//i.test(t)) return null;
  let u: URL;
  try { u = new URL(t); } catch { return null; }
  u.hash = '';
  u.protocol = 'https:';
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
  const drop: string[] = [];
  u.searchParams.forEach((_v, k) => {
    if (/^(utm_|ic|mod$|cmp$|cmpid$|src$|source$|ref$|fbclid$|gclid$|guccounter$|amp$|guce_)/i.test(k)) drop.push(k);
  });
  for (const k of drop) u.searchParams.delete(k);
  let s = u.toString();
  if (s.endsWith('?')) s = s.slice(0, -1);
  // Trailing-slash variants are the single most common duplicate shape.
  if (s.endsWith('/') && !u.search) s = s.slice(0, -1);
  return s.slice(0, 1500);
}


/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * Business Wire MCP — press releases from Business Wire's all-news RSS feed.
 *
 * Sourced from feed.businesswire.com, keyless, no account, no clickthrough
 * terms (probed live 2026-09-21..22). Public data a Disallow line does not
 * gate — see the "public data is public data" ruling in project CLAUDE.md.
 *
 * WHY WAVE 1 CALLED THIS WIRE DEAD, AND WHY IT IS NOT (fleet #2286): the
 * wave-1 probe recorded "a 993-byte 200 with an empty items array". Those
 * bytes are an RSS envelope with ZERO items whose <description> reads
 * "RSS channel ID is not available in the request. Please make sure you have
 * a valid RSS link." — Business Wire answers an invalid or missing `rss=`
 * token with HTTP 200 and an error written inside the channel, not with a
 * 4xx. Reproduced at 1,001 bytes with `?rss=bogus`. The status line cannot
 * tell that apart from a quiet feed; `count` / `newest_item_at` can.
 *
 * WHERE THE TOKEN CAME FROM: www.businesswire.com is behind Akamai and
 * answers a non-browser User-Agent with 403 on every path, including its
 * own robots.txt and the RSS index page. feed.businesswire.com is a
 * different host that answers our own identity fine, and ITS robots.txt
 * lists this feed as a Sitemap line:
 *   Sitemap: http://feed.businesswire.com/mrss/home/?rss=G1QFDERJXkJcFVJYWQ==
 * The same token on the /rss/ path (below) is Business Wire's full all-news
 * channel. Tokens are opaque per-channel ids, not readable paths; per-
 * industry channels exist (e.g. G1QFDERJXkJeEFpRVQ== is "Communications
 * News", vnsId 31209) but the index that maps them is on the blocked host,
 * so this pack reads the all-news channel only.
 *
 * COVERAGE, STATED HONESTLY: the all-news channel is DENSE — measured live
 * 2026-09-22: 3,492 items spanning a rolling ~7-day window (oldest
 * 2026-09-15 01:37 UTC, newest 2026-09-22 01:30 UTC), ~4 MB of XML fetched
 * in under half a second. That is a week of the whole wire, which is far
 * more than the ~20-item windows of the GlobeNewswire / PR Newswire packs,
 * but it is still a rolling window and NOT an archive: every call re-fetches
 * it live, and a release older than about a week is gone.
 *
 * ITEM SHAPE: title, pubDate, description, link (with a `feedref=` tracking
 * token this pack strips), guid (Business Wire's own release id, e.g.
 * `20260921847964en`), and an image enclosure. There is NO issuer tag. The
 * description opens with the wire's dateline — "BENGALURU, India--(BUSINESS
 * WIRE)--Rippling, the ..." — so this pack splits on the `--(BUSINESS WIRE)--`
 * marker into `dateline` and `excerpt`. The issuer usually leads the excerpt
 * but is not a separate field; search matches headline + excerpt.
 *
 * feed-parse.ts`, hardened against 85 live feeds, fleet #2285). Its
 * `newestItemAt` is how a caller tells a quiet wire from a dead one.
 */


const SOURCE = 'Business Wire';
const FEED_URL = 'https://feed.businesswire.com/rss/home/?rss=G1QFDERJXkJcFVJYWQ==';
/** Our own identity. feed.businesswire.com serves this UA; forging a browser is neither needed nor done. */
const UA = 'pipeworx-mcp/1.0 (+https://pipeworx.io)';
const COVERAGE_NOTE =
  "Business Wire's all-news RSS channel: every release on the wire for a rolling window of roughly the last 7 days " +
  '(measured ~3,500 releases). Every call re-fetches this window live; it is not an archive, and releases older ' +
  'than about a week are no longer in it.';
const DATELINE_MARKER = /--\(BUSINESS WIRE\)--/;
const MAX_LIMIT = 100;

/**
 * Retries a non-2xx up to 3 attempts total (the wave-1 wires found transient
 * bot-management redirects that 404 on ~1 in 3 fresh requests at PR Newswire;
 * not observed here, but cheap insurance against reporting the wire dead on
 * a hiccup). A 200 whose channel carries the "RSS channel ID is not available"
 * error is reported as exactly that, because it is what the wave-1 probe
 * mistook for a dead wire.
 */
const FEED_TTL_MS = 60_000;
/** The channel is ~4 MB; one fetch per isolate per minute, whatever the arguments. Populated lazily at request time. */
let memo: { xml: string; at: number } | null = null;

async function bwFetch(): Promise<{ xml: string; via: string }> {
  if (memo && Date.now() - memo.at < FEED_TTL_MS) return { xml: memo.xml, via: FEED_URL };
  let res: Response | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetchWithTimeout(FEED_URL, { headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml, */*' } }, SOURCE);
    if (res.ok) break;
  }
  if (!res || !res.ok) throw new Error(`upstream_down: ${SOURCE} answered HTTP ${res?.status} for its RSS feed (after 3 attempts).`);
  const xml = await res.text();
  if (!/<item[\s>]/i.test(xml)) {
    const channelDesc = feedTag(xml, 'description');
    if (/RSS channel ID is not available/i.test(channelDesc)) {
      throw new Error(
        `upstream_down: ${SOURCE} answered HTTP 200 with zero items and the channel description "${channelDesc}" — ` +
          'the feed token this pack uses is no longer accepted. Business Wire reports an invalid token as a 200, ' +
          'not a 4xx.',
      );
    }
    throw new Error(
      `upstream_down: ${SOURCE} answered HTTP ${res.status} with no <item> elements (${xml.length} bytes) — ` +
        'the feed may be temporarily empty or its shape has changed.',
    );
  }
  memo = { xml, at: Date.now() };
  return { xml, via: FEED_URL };
}

interface Release {
  headline: string;
  release_id: string | null;
  /** BCP-47-ish code from the release id / URL path: "en", "zh-CN", "ja", "de"… The channel is MULTILINGUAL. */
  language: string | null;
  dateline: string | null;
  url: string;
  canonical_url: string;
  published_at?: string;
  excerpt?: string;
  image_url?: string;
}

/** Business Wire links carry a per-feed `feedref=` tracking token; the path alone is the release. */
function stripTracking(link: string): string {
  try {
    const u = new URL(link);
    u.search = '';
    u.hash = '';
    u.protocol = 'https:';
    let s = u.toString();
    if (s.endsWith('/')) s = s.slice(0, -1);
    return s;
  } catch {
    return link.split('?')[0].replace(/\/$/, '');
  }
}

function splitDateline(description: string): { dateline: string | null; excerpt: string | undefined } {
  const m = DATELINE_MARKER.exec(description);
  if (!m) return { dateline: null, excerpt: description.slice(0, 400) || undefined };
  const dateline = description.slice(0, m.index).trim() || null;
  const body = description.slice(m.index + m[0].length).trim();
  return { dateline, excerpt: body.slice(0, 400) || undefined };
}

function toReleases(xml: string): { releases: Release[]; newestItemAt: string | null } {
  const parsed = parseFeed(xml);
  const blocks = feedItemBlocks(xml);
  const releases: Release[] = parsed.items.map((item, i) => {
    const block = blocks[i] ?? '';
    // parseFeed's excerpt is already entity-decoded and tag-stripped; the raw
    // <description> is needed only for the dateline split, which is plain text.
    const { dateline, excerpt } = splitDateline(item.excerpt ?? '');
    const enclosure = /<enclosure[^>]*url=["']([^"']+)["']/i.exec(block);
    const releaseId = feedTag(block, 'guid') || null;
    // guid is <14-digit id><language>, e.g. 20260921847964en / 20260917064237zh-CN;
    // the same code is the URL path segment after the id.
    const langFromId = releaseId ? /^\d{14}([A-Za-z]{2}(?:-[A-Za-z]{2,4})?)$/.exec(releaseId) : null;
    const langFromUrl = /\/news\/home\/\d{14}\/([A-Za-z]{2}(?:-[A-Za-z]{2,4})?)\//.exec(item.link);
    return {
      headline: item.title,
      release_id: releaseId,
      language: langFromId?.[1] ?? langFromUrl?.[1] ?? null,
      dateline,
      url: item.link,
      canonical_url: stripTracking(item.link),
      published_at: item.publishedAt,
      excerpt,
      image_url: enclosure ? enclosure[1] : undefined,
    };
  });
  releases.sort((a, b) => (Date.parse(b.published_at ?? '') || 0) - (Date.parse(a.published_at ?? '') || 0));
  return { releases, newestItemAt: parsed.newestItemAt };
}

function applySince(releases: Release[], sinceHours: number | null): Release[] {
  if (sinceHours == null) return releases;
  const cutoff = Date.now() - sinceHours * 3_600_000;
  return releases.filter((r) => r.published_at && Date.parse(r.published_at) >= cutoff);
}

/**
 * The all-news channel carries every language Business Wire distributes in
 * (measured 2026-09-22: the newest item was a zh-CN re-release of a 09-17
 * English original), so an unfiltered "latest" can lead with Chinese or
 * Japanese rows. `language` narrows to one code; "en" is the usual ask.
 * Matching is case-insensitive on the full code ("zh-CN") or its primary
 * subtag ("zh").
 */
function applyLanguage(releases: Release[], language: string | null): Release[] {
  if (!language) return releases;
  const want = language.toLowerCase();
  return releases.filter((r) => {
    const have = (r.language ?? '').toLowerCase();
    return have === want || have.split('-')[0] === want;
  });
}

function strArg(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim() : '';
  return s ? s : null;
}

const LANGUAGE_ARG = {
  type: 'string',
  description: 'Restrict to one language code, e.g. "en" (the channel is multilingual: en, zh-CN, zh-HK, ja, de, fr, es… — a release can appear once per language). Omit for all languages.',
};

const tools: McpToolExport['tools'] = [
  {
    name: 'businesswire_latest_releases',
    description:
      "Latest press releases from Business Wire's all-news RSS channel (source: businesswire.com). Returns headline, " +
      'dateline, language, published time, excerpt and release id for each release, newest first. The channel holds ' +
      "roughly the last 7 days of the whole wire (~3,500 releases, every language Business Wire distributes in) — " +
      "not Business Wire's full archive. Pass language \"en\" for English only.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        since_hours: { type: 'number', description: 'Only return releases published within the last N hours (optional; the window covers about 168).' },
        language: LANGUAGE_ARG,
        limit: { type: 'number', description: `Max releases to return, 1-${MAX_LIMIT} (default 20).` },
      },
    },
  },
  {
    name: 'businesswire_search_releases',
    description:
      "Keyword/company search over Business Wire's current all-news channel (source: businesswire.com). Matches " +
      'against headline, dateline and excerpt across roughly the last 7 days of the wire (~3,500 releases, all ' +
      'languages unless language is set) — not a historical archive.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Company name or keyword to match.' },
        since_hours: { type: 'number', description: 'Only consider releases published within the last N hours (optional).' },
        language: LANGUAGE_ARG,
        limit: { type: 'number', description: `Max matches to return, 1-${MAX_LIMIT} (default 20).` },
      },
      required: ['query'],
    },
  },
  {
    name: 'businesswire_get_release',
    description:
      'Fetch one specific Business Wire release by its URL or release id (source: businesswire.com), as returned ' +
      'by businesswire_latest_releases or businesswire_search_releases. Re-fetches the live channel each call — a ' +
      'release older than the ~7-day window will not be found.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'The release URL or release_id (e.g. 20260921847964en) from a prior businesswire tool call.' },
      },
      required: ['url'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'businesswire_latest_releases': {
      const { xml, via } = await bwFetch();
      const { releases, newestItemAt } = toReleases(xml);
      const language = strArg(args.language);
      const out = applyLanguage(applySince(releases, numArg(args.since_hours)), language);
      const limit = clamp(numArg(args.limit) ?? 20, 1, MAX_LIMIT);
      return {
        source: SOURCE,
        feed_url: via,
        coverage: COVERAGE_NOTE,
        newest_item_at: newestItemAt,
        oldest_item_at: releases.length ? releases[releases.length - 1].published_at ?? null : null,
        ...(language ? { language } : {}),
        count: Math.min(out.length, limit),
        total_in_window: releases.length,
        releases: out.slice(0, limit),
      };
    }
    case 'businesswire_search_releases': {
      const query = String(args.query ?? '').trim();
      if (!query) throw new Error('user_error: Pass a non-empty `query` (company name or keyword).');
      const { xml } = await bwFetch();
      const { releases, newestItemAt } = toReleases(xml);
      const language = strArg(args.language);
      const pool = applyLanguage(applySince(releases, numArg(args.since_hours)), language);
      const q = query.toLowerCase();
      const matches = pool.filter(
        (r) =>
          r.headline.toLowerCase().includes(q) ||
          (r.dateline ?? '').toLowerCase().includes(q) ||
          (r.excerpt ?? '').toLowerCase().includes(q),
      );
      const limit = clamp(numArg(args.limit) ?? 20, 1, MAX_LIMIT);
      return {
        source: SOURCE,
        coverage: COVERAGE_NOTE,
        newest_item_at: newestItemAt,
        query,
        ...(language ? { language } : {}),
        scanned: pool.length,
        count: Math.min(matches.length, limit),
        releases: matches.slice(0, limit),
      };
    }
    case 'businesswire_get_release': {
      const raw = String(args.url ?? '').trim();
      if (!raw) throw new Error('user_error: Pass the release `url` (or release_id) from a prior businesswire tool call.');
      const { xml } = await bwFetch();
      const { releases, newestItemAt } = toReleases(xml);
      const target = /^https?:\/\//i.test(raw) ? stripTracking(raw) : null;
      const hit = releases.find(
        (r) =>
          (target !== null && (r.canonical_url === target || r.url === raw)) ||
          (r.release_id !== null && (r.release_id === raw || (target === null && raw.includes(r.release_id)))),
      );
      if (!hit) {
        throw new Error(
          "user_error: Not found in the current channel window (Business Wire's all-news channel keeps roughly the " +
            'last 7 days). This tool re-fetches the live channel on every call; call businesswire_latest_releases or ' +
            'businesswire_search_releases first to get a URL or release_id still in the window.',
        );
      }
      return { source: SOURCE, coverage: COVERAGE_NOTE, newest_item_at: newestItemAt, release: hit };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function numArg(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}
function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
