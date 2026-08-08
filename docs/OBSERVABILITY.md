# Observability: Structured Logging Reference

WingDex emits structured logs from every Cloudflare Worker using a standard 6-level hierarchy. This document is the canonical reference for the schema, conventions, and operational practices.

## Schema

Every log line is a JSON object (or a compact one-liner when `LOG_FORMAT=pretty`):

| Field | Required | Type | Notes |
|---|---|---|---|
| `time` | yes | string | ISO 8601 UTC timestamp |
| `level` | yes | string | `Trace`, `Debug`, `Info`, `Warning`, `Error`, `Critical` |
| `traceId` | yes | string | W3C trace-id (32 hex chars) |
| `spanId` | yes | string | W3C span-id (16 hex chars) |
| `operationName` | yes | string | `resourceType/subType/verb` (camelCase) |
| `category` | recommended | string | `Audit`, `Application`, or `Request` |
| `userId` | when known | string | Top-level for easy querying |
| `identity` | when known | object | `{ isAnonymous, authMethod }` |
| `resourceId` | when applicable | string | `/users/{userId}/outings/{id}` etc. |
| `resultType` | recommended | string | `Succeeded` or `Failed` |
| `resultSignature` | on HTTP responses | number | HTTP status code |
| `resultDescription` | on failures | string | Human-readable: context, cause, mitigation |
| `durationMs` | on completion | number | Wall-clock time (ms) |
| `properties` | optional | object | Machine-queryable extras (counts, IDs, enums) |

Middleware completion logs include OTel-convention transport fields in `properties`:
- `http.method` - HTTP request method (GET, POST, PATCH, DELETE)
- `http.route` - URL pathname (e.g. `/api/auth/callback/github`, `/api/data/outings/outing_123`)

## Log levels

Standard 6-level hierarchy, controlled by `LOG_LEVEL` env var:

| Level | Purpose | When to use |
|---|---|---|
| `Trace` | Ultra-verbose operational diagnostics | Safe pipeline state and aggregate maps. Never credentials or user content. |
| `Debug` | Sub-step diagnostic detail | Bird-id pipeline stages, batch counts, import parsing. Local dev. |
| `Info` | Significant business events | Request completion (1 per request), audit events. **Production baseline.** |
| `Warning` | Client errors, degraded paths | 4xx responses, validation failures. Emitted at `warn` level and above. |
| `Error` | Server errors, exceptions | 5xx responses, unhandled exceptions. Emitted at `error` level and above. |
| `Critical` | System-level failures | Reserved for data loss, security breach. Emitted at all levels. |

### LOG_LEVEL env var

| Value | What's visible | Where to use |
|---|---|---|
| `trace` | Everything | On-demand deep debugging sessions |
| `debug` | Debug + Info + Warning + Error + Critical | **Local dev** (set in `.dev.vars`) |
| `info` (default) | Info + Warning + Error + Critical | **Production** and **preview** |
| `warn` (or `warning`) | Warning + Error + Critical | Quiet mode (errors and warnings only) |
| `error` | Error + Critical only | Minimal output |

Legacy `DEBUG=1` maps to `LOG_LEVEL=debug` for backwards compatibility.

### LOG_FORMAT env var

| Value | Output format | Where to use |
|---|---|---|
| (not set) | JSON (one object per line) | **Production**, preview, log analytics |
| `pretty` | Compact one-liner | **Local dev** terminal |

Pretty format example:
```
19:04:24 INFO     data/all/read 200 42ms [u1234567] Fetched 5 outings, 12 photos
19:04:24 DEBUG    birdId/llmCall/invoke [u1234567] LLM returned 3 raw candidates
19:04:27 WARNING  import/ebirdCsv/import 400 [u1234567] No CSV file in form field
19:04:27 ERROR    birdId/identify/invoke 502 2500ms [u1234567] AI returned unparseable response
```

## Environment-specific configuration

### Production
`GEOAPIFY_KEY` is required as a secret for geocoding. Logging defaults to `LOG_LEVEL=info`, JSON format. You see request completions (1 line each with durationMs + status + userId), audit events, and all warnings/errors.

Cloudflare automatic trace capture is disabled in `wrangler.toml`. Outbound fetch spans can retain complete request URLs, including submitted geocoding queries or rounded coordinates. Request-scoped structured logs remain enabled and deliberately record only route names, statuses, durations, safe identifiers, counts, and enums.

### Preview / staging
Same as production: `LOG_LEVEL=info`, JSON format. Preview deployments use the same log config so you can verify the production log experience before merging.

### Local dev
Add to `.dev.vars`:
```
LOG_LEVEL=debug
LOG_FORMAT=pretty
```
You see sub-step detail (bird-id pipeline, import parsing, batch counts) in a compact terminal-friendly format.

### Deep debugging
Temporarily set `LOG_LEVEL=trace` to see additional safe pipeline diagnostics. Trace level does not permit credentials, response bodies, user-authored content, or provider/database exception text. Revert when done.

## Safe metadata policy

Logs may include stable operational metadata needed to correlate and diagnose requests:

- top-level `userId`, internal `resourceId`, trace/span IDs
- internal outing, observation, or photo IDs when they identify the affected resource
- HTTP status, method, route, duration, response byte count
- aggregate counts, booleans, enums, configured limits, and retry durations

Logs must never include:

- raw or signed session tokens, cookies, authorization headers, OAuth callback URLs, passkey credential IDs, or challenge payloads
- email addresses, profile image URLs/data, filenames, notes, outing/location names, species-name arrays, CSV contents, or image data
- request/response bodies, provider payloads, database/provider exception messages, or stack traces
- outbound geocoding URLs (which contain the provider key), raw place queries, or coordinates

Geocoding logs only route-level completion status and result counts. WingDex does not cache provider responses or log upstream URLs and payloads.
Automatic Worker invocation logs are disabled because request URLs can contain place queries or coordinates; structured application logs remain enabled.

Geoapify Free currently allows 3,000 credits per day and 5 requests per second. A submitted place search costs one credit. A GPS suggestion costs one Places credit and, only when no named outdoor place is found, one reverse-geocoding credit. Monitor the Geoapify project dashboard and upgrade before normal daily usage approaches the quota; repeated quota pressure or abuse should trigger an authenticated per-user limit rather than global coordination infrastructure.

Use a stable operation summary plus safe metadata in catch blocks, for example: `Outing deletion failed; inspect the trace and database operation` with `{ outingId }`. The trace ID is the correlation handle; raw exception text is not a logging shortcut.

### Tracing a specific user in production
Query CF Workers Logs (or log analytics) by `userId` at Info level - it's a top-level field on every log line. If you need sub-step detail for a production issue, temporarily set `LOG_LEVEL=debug` in Cloudflare Workers env vars and redeploy. Revert after investigation.

## Category

| Value | Meaning | Examples |
|---|---|---|
| `Audit` | Security/compliance-relevant changes. Info-level Audit events are the production baseline - always visible. | Passkey finalization, data clear |
| `Application` | Normal application logic. | CRUD, bird ID, import/export, species lookup, health check |
| `Request` | Middleware request lifecycle. | Completion log with durationMs, pre-auth rejections (405/413), unhandled 500s |

## operationName conventions

Format: `resourceType/subType/verb` in camelCase.

Verbs are specific to what the operation does: `read`, `write`, `delete`, `invoke`, `import`, `export`, `validate`.

### Complete operationName table

| Route file | operationName | category | Description |
|---|---|---|---|
| Middleware: request completion | Derived from ROUTE_MAP | Request | One per request with durationMs |
| Middleware: 405/400/413 | `requests/validation/validate` | Request | Pre-auth rejections |
| Middleware: 401 no session | `auth/sessions/validate` | Request | Session lookup failed |
| Middleware: 500 unhandled | Route's op from map | Request | Unhandled exception |
| api/health.ts | `health/database/read` | Application | |
| api/identify-bird.ts | `birdId/identify/invoke` | Application | |
| lib/bird-id.ts (LLM call) | `birdId/llmCall/invoke` | Application | |
| lib/bird-id.ts (taxonomy) | `birdId/taxonomyMatch/invoke` | Application | |
| lib/bird-id.ts (range filter) | `birdId/rangeFilter/invoke` | Application | |
| lib/bird-id.ts (range priors) | `birdId/rangePriors/read` | Application | |
| lib/bird-id.ts (range adjust) | `birdId/rangeAdjust/invoke` | Application | |
| api/data/all.ts | `data/all/read` | Application | |
| api/data/observations.ts | `data/observations/write` | Application | |
| api/data/outings.ts | `data/outings/write` | Application | |
| api/data/outings/[id].ts PATCH | `data/outings/write` | Application | |
| api/data/outings/[id].ts DELETE | `data/outings/delete` | Application | |
| api/data/photos.ts | `data/photos/write` | Application | |
| api/data/dex.ts GET | `data/dex/read` | Application | |
| api/data/dex.ts PATCH | `data/dex/write` | Application | |
| api/data/clear.ts | `data/clear/delete` | Audit | Destructive |
| api/auth/finalize-passkey.ts | `auth/finalizePasskey/invoke` | Audit | Security event |
| api/auth/linked-providers.ts | `auth/linkedProviders/read` | Application | |
| api/auth/mobile/start.ts | `auth/mobileOAuth/invoke` | Application | |
| api/auth/mobile/callback.ts | `auth/mobileOAuth/invoke` | Application | |
| api/import/ebird-csv.ts | `import/ebirdCsv/import` | Application | |
| api/import/ebird-csv/confirm.ts | `import/ebirdCsvConfirm/write` | Application | |
| api/export/dex.ts | `export/dex/export` | Application | |
| api/export/sightings.ts | `export/sightings/export` | Application | |
| api/export/outing/[id].ts | `export/outingCsv/export` | Application | |
| api/species/search.ts | `species/search/read` | Application | |
| api/species/ebird-code.ts | `species/ebirdCode/read` | Application | |
| api/species/wiki-title.ts | `species/wikiTitle/read` | Application | |

## resourceId hierarchy

Auto-built by middleware after session check:

```
/users/{userId}                                          -- base for all authenticated requests
/users/{userId}/outings/{outingId}                       -- outing-specific (auto from URL params)
/users/{userId}/outings/{outingId}/observations          -- observation batch ops (via withResourceId)
/users/{userId}/outings/{outingId}/observations/{obsId}  -- single observation patch
/users/{userId}/outings/{outingId}/photos                -- photo batch ops (via withResourceId)
/users/{userId}/dex                                      -- dex read/write/export (via withResourceId)
/users/{userId}/dex/{speciesName}                        -- single species dex patch
```

Middleware auto-sets `/users/{userId}` and appends outing IDs from URL params (for `/api/data/outings/:id` and `/api/export/outing/:id`). When middleware scopes resourceId from URL params, it sets `context.data.autoScopedResourceId = true` so handlers know NOT to call `withResourceId` for the same entity. Route handlers extend with `log.withResourceId('dex')` or `log.withResourceId('outings/' + body.id)` only for body-derived entity IDs. Batch operations use the parent resource path and put individual IDs in `properties`.

## Error message quality

Every `resultDescription` must follow the "include the affected entity" principle:

**Bad:** `"Invalid outing reference"`
**Good:** `"Outing outing_abc123 referenced by 3 observations is not owned by user or does not exist; the outing may have been deleted by another client"`

Every error message should include:
1. **Context**: what was being attempted
2. **The error itself**: what specifically failed (with entity names/IDs)
3. **Mitigation**: what to do about it

## Health endpoint

`/api/health` is polled every 30 seconds by the dev server health check script. Successful (2xx) completion logs are suppressed in middleware to avoid noise. Failures still log at Warning/Error level.

## Identity caveat

Middleware resolves the session (and therefore `userId`) for non-`/api/auth/*` routes. Auth routes only carry `authMethod` in `identity` - `userId` is absent.

## Required practices for new/changed code

1. **Use `createRouteResponder`** at the top of every handler to bind operationName and category once:
   ```ts
   const route = createRouteResponder((context.data as RequestData).log, 'data/outings/write', 'Application')
   ```
2. **Use `route.fail(status, body, detail?, properties?)`** for all error responses. It logs + returns Response in one call - impossible to forget a log site:
   ```ts
   return route.fail(400, 'Invalid JSON body')
   return route.fail(404, 'Not found', `Outing ${outingId} not found or not owned by user`, { outingId })
   ```
3. **Use `route.info()`, `route.debug()`, `route.trace()`** for success/diagnostic logging. Never repeat operationName or category.
4. **Wrap all DB operations in try/catch** with `route.fail(500, 'Internal server error', detail, properties)` in the catch block.
5. **Include entity context** in error messages: outing IDs, observation IDs, counts. Use the `detail` parameter for rich descriptions and `properties` for machine-queryable data.
6. **Scope resourceId** when operating on a specific entity: `createRouteResponder(log?.withResourceId('outings/' + outingId), ...)`
7. **Propagate `traceparent`** on outbound calls (web -> API, iOS -> API).
8. **Expose only safe expected 4xx details** to clients. Never surface or log raw 5xx bodies, HTML, exception text, or provider/database payloads.

### Route handler template

```ts
export const onRequestPost: PagesFunction<Env> = async context => {
  const userId = (context.data as { user?: { id?: string } }).user?.id
  const route = createRouteResponder((context.data as RequestData).log, 'data/outings/write', 'Application')
  if (!userId) return new Response('Unauthorized', { status: 401 })

  let body: unknown
  try { body = await context.request.json() }
  catch { return route.fail(400, 'Invalid JSON body', 'Request body is not valid JSON') }

  if (!isValid(body)) return route.fail(400, 'Invalid payload', 'Detailed description of what is wrong')

  try {
    // ... DB operations ...
    route.debug('Created outing', { outingId: body.id })
    return Response.json(result)
  } catch {
    return route.fail(500, 'Internal server error', 'Outing creation failed; inspect the trace and database operation', { outingId: body.id })
  }
}
```

### Choosing info vs debug

Ask: "Would an ops engineer need to see this for every request in production?" If yes -> `route.info()`. If only useful when debugging -> `route.debug()`. Use `route.trace()` only for additional safe operational metadata, never for raw payloads or user content.
