# Observability: Structured Logging Reference

WingDex emits structured operational events from Cloudflare Workers. This document is the canonical reference for the emitted schema, event boundaries, privacy rules, and validation workflow.

## Production representation

The production logger passes one structured JavaScript object directly to `console.log` or `console.error`. It does not call `JSON.stringify`. Cloudflare already extracted fields from the previous JSON-string representation, so direct objects preserve field-level querying while removing unnecessary serialization.

WingDex does not define a custom `message` or `summary` field. Use `operationName`, `resultDescription`, `resultType`, and the other structured fields. Cloudflare's default **Message** column may be blank for WingDex object events. Third-party warnings that emit strings can populate **Message**; they are not WingDex schema events.

Each logger call is one log event. A routine API invocation normally emits one terminal `Request` event. Durable or interruptible transitions add `Application` or `Audit` events, so event count is intentionally greater than request count for those flows. Automatic Worker invocation logs are disabled to avoid a duplicate event per invocation. Cloudflare traces are disabled to avoid retaining outbound URLs and extra trace events.

`LOG_FORMAT=pretty` is a local terminal convenience. It emits compact strings instead of structured objects and must not be enabled in preview or production.

## Schema

| Field | Required | Type | Operational meaning |
|---|---|---|---|
| `time` | yes | string | ISO 8601 UTC event time |
| `level` | yes | string | `Trace`, `Debug`, `Info`, `Warning`, `Error`, or `Critical` |
| `traceId` | yes | string | W3C trace ID used to order events from one invocation |
| `spanId` | yes | string | W3C span ID for the Worker invocation |
| `operationName` | yes | string | Stable `resourceType/subType/verb` name |
| `category` | operational events | string | `Request`, `Application`, or `Audit` |
| `userId` | when middleware resolves it | string | Authenticated account correlation key |
| `identity` | when known | object | Safe auth context: `isAnonymous` and/or `authMethod` |
| `resourceId` | when middleware scopes it | string | Controlled hierarchy such as `/users/{userId}/outings/{outingId}` |
| `resultType` | terminal outcomes | string | `Succeeded` or `Failed`; omitted on start markers |
| `resultSignature` | terminal requests | number | HTTP status code |
| `resultDescription` | operational events | string | Primary human-readable operational statement |
| `durationMs` | terminal requests | number | Invocation wall-clock time |
| `properties` | optional | object | Safe aggregate counts, booleans, enums, limits, or transport fields |

Terminal `Request` events include:

- `properties.http.method`: HTTP method.
- `properties.http.route`: stable route template from middleware, never the raw pathname. Examples are `/api/data/outings/:id`, `/api/export/outing/:id`, `/api/auth/:path`, and `/api/:unknown`.

Route handlers carry terminal outcome details to middleware in private response headers. Middleware consumes and removes them before returning the response:

- `X-WingDex-Result-Description`
- `X-WingDex-Result-Type`

`route.fail(..., properties)` and `route.failWithHeaders(..., properties)` currently discard the `properties` argument. They transport only `resultDescription` and `resultType`. Put the operationally useful, privacy-safe fact in `resultDescription`; do not depend on failure properties reaching the terminal `Request` event.

## Event boundaries

### Request

`Request` is the authoritative terminal record for an API invocation. Middleware emits exactly one terminal event with status, duration, route template, result, and trace ID:

- Successful and failed handler responses complete in middleware.
- Pre-handler method, content-length, body-size, and session rejections emit their terminal event and return immediately.
- An unhandled exception emits one failed terminal event.
- OAuth callback redirects with an `error=` result are marked `Failed` even though the HTTP status is 3xx.

Do not add a second route-level completion log. Successful `/api/health` polling is the intentional exception and emits no event; failed health checks still emit one terminal `Request` event.

### Application

`Application` records a durable or interruptible business transition that cannot be reconstructed safely from HTTP completion alone. It answers questions such as "Did the database commit before post-processing failed?" and "Which external revocation completed before deletion stopped?"

- External or multi-step transitions use a start marker before the interruptible boundary and an outcome after it. The outcome has `resultType`; the start marker does not.
- A route's terminal `Request` event can be the outcome when it fully describes the external step. For example, geocoding emits an `Application` marker only when fallback starts, then the terminal `Request` records the final result.
- Atomic database hooks run after the durable change. They emit only one `Succeeded` outcome, never a speculative start.
- Routine reads, validation, and CRUD completion stay in the terminal `Request` event.

### Audit

`Audit` is reserved for the explicit all-data clear. The clear emits one durable `Audit` outcome after its deletion batch commits, in addition to the terminal `Request` event. Account lifecycle events are `Application`, not `Audit`.

## Levels and configuration

| Level | Use |
|---|---|
| `Trace` | Additional safe diagnostic state during a short investigation |
| `Debug` | Safe sub-step detail useful in local development |
| `Info` | Successful terminal requests and expected durable transitions |
| `Warning` | 4xx/semantic request failures and degraded paths requiring attention |
| `Error` | 5xx outcomes, unexpected failures, or a transition that could not complete |
| `Critical` | Reserved for confirmed data loss or a security breach |

`LOG_LEVEL` controls the minimum level. `info` is the default for preview and production; `debug` is appropriate locally; `trace` is temporary. Legacy `DEBUG=1` maps to `debug`.

Local terminal setup:

```dotenv
LOG_LEVEL=debug
LOG_FORMAT=pretty
```

Example pretty output:

```text
19:04:24 INFO     data/all/read 200 42ms [u1234567] Loaded account data with 5 outings
19:04:27 WARNING  import/ebirdCsv/import 400 [u1234567] CSV upload did not include a file
19:04:28 ERROR    auth/account/delete 502 315ms [u1234567] Account deletion stopped before local deletion because GitHub revocation failed with upstream HTTP 503
```

## Account lifecycle timelines

Atomic Better Auth database hooks emit outcome-only `Application` events after the database change succeeds:

| operationName | Emission condition |
|---|---|
| `auth/account/create` | A temporary anonymous or persistent account was created |
| `auth/provider/link` | A GitHub, Apple, Google, or credential account was linked |
| `auth/session/create` | A server session was created, including passkey authentication |
| `auth/session/delete` | A server session was deleted by sign-out |

Typical event order is:

- New anonymous session: `auth/account/create`, `auth/session/create`, terminal `auth/sessions/invoke` Request.
- New social account: `auth/account/create`, `auth/provider/link`, `auth/session/create`, terminal callback Request.
- Existing account authentication: `auth/session/create`, terminal auth Request. A newly linked provider adds `auth/provider/link` before the session event.

Passkey events are also outcome-only because they are emitted only after the corresponding operation succeeds:

- `auth/passkey/create`: Better Auth returned success after durable passkey registration.
- `auth/account/upgrade`: passkey finalization changed an anonymous user into a persistent account.
- `auth/session/create`: successful passkey authentication created a session.
- `auth/passkey/delete`: Better Auth returned success after deleting an owned passkey.
- `auth/appleRevocationToken/write`: native Apple token exchange completed and revocation credentials were durably stored for future account deletion.

Each route also has its one terminal `Request` event. For passkey signup, registration and account finalization are separate invocations and therefore separate traces.

### Account deletion

Account deletion is externally interruptible and emits this ordered `Application` timeline under one trace:

1. `auth/linkedProviders/read` outcome: provider preflight succeeded with a count, or failed before revocation/local deletion began.
2. For each linked external provider, `auth/provider/revoke` start, followed by a `Succeeded` or `Failed` outcome. Credential accounts are the exception: they emit no external revocation start and one `Succeeded` no-external-revocation outcome.
3. `auth/account/delete` start after all provider processing that permits deletion.
4. `auth/account/delete` outcome after the local user delete succeeds or fails. The user delete cascades local account data.
5. One terminal `auth/account/delete` `Request` event describes the HTTP result.

Provider outcomes have intentionally different semantics:

- Credential accounts emit no revocation start and one `Succeeded` no-external-revocation outcome because no external grant exists.
- Apple without stored revocation credentials emits `Warning` + `Failed`: the external obligation remains incomplete and manual revocation in Apple Account settings is required, but local deletion continues.
- A configured-provider revocation failure emits `Error` + `Failed` and stops before local deletion. Upstream HTTP status may be included; tokens and provider payloads may not.
- Retrying deletion is expected to be idempotent after partial provider revocation or a local deletion failure.

## Non-auth transition events

These events exist only when the named durable/interruptible boundary is crossed:

| operationName | category | Emission rule |
|---|---|---|
| `data/clear/delete` | Audit | Outcome after the batch deletes outings, cascaded observations/photos, and dex metadata |
| `import/ebirdCsv/import` | Application | Commit marker after a non-empty import batch, before dex recomputation |
| `data/outings/delete` | Application | Delete marker after one outing and its cascades commit, before dex recomputation |
| `geocoding/reverse/read` | Application | Start marker only when Places yields no usable outdoor place and reverse-geocoding fallback begins |
| `data/observations/write` | Application | For POST batches larger than one: commit/verification marker before dex recomputation, including post-commit verification failure |
| `data/observations/write` | Application | For PATCH batches larger than one: commit marker after at least one requested update, before readback/dex recomputation |
| `data/dex/write` | Application | For batches larger than one: all-applied marker before recomputation, or partial-application marker if a later write fails |

Single observation writes, single observation patches, and single dex metadata patches use only the terminal `Request` outcome.

## Operation routing

Every terminal route event has category `Request`. Middleware resolves the following stable route template and `operationName`; no bird-identification route is currently present.

| Method | Stable route | operationName |
|---|---|---|
| any | `/api/health` | `health/database/read` |
| POST | `/api/data/outings` | `data/outings/write` |
| PATCH | `/api/data/outings/:id` | `data/outings/write` |
| DELETE | `/api/data/outings/:id` | `data/outings/delete` |
| POST, PATCH | `/api/data/observations` | `data/observations/write` |
| POST | `/api/data/photos` | `data/photos/write` |
| GET | `/api/data/dex` | `data/dex/read` |
| PATCH | `/api/data/dex` | `data/dex/write` |
| DELETE | `/api/data/clear` | `data/clear/delete` |
| GET | `/api/data/all` | `data/all/read` |
| GET | `/api/auth/linked-providers` | `auth/linkedProviders/read` |
| POST | `/api/auth/apple/revocation-token` | `auth/appleRevocationToken/write` |
| POST | `/api/auth/delete-account` | `auth/account/delete` |
| POST | `/api/auth/mobile/start` | `auth/mobileOAuth/invoke` |
| POST | `/api/auth/mobile/callback` | `auth/mobileOAuth/invoke` |
| varied | `/api/auth/:path` | `auth/sessions/invoke` |
| POST | `/api/import/ebird-csv` | `import/ebirdCsv/import` |
| GET | `/api/export/outing/:id` | `export/outingCsv/export` |
| GET | `/api/export/dex` | `export/dex/export` |
| GET | `/api/export/sightings` | `export/sightings/export` |
| GET | `/api/species/search` | `species/search/read` |
| GET | `/api/species/ebird-code` | `species/ebirdCode/read` |
| GET | `/api/species/wiki-title` | `species/wikiTitle/read` |
| POST | `/api/geocoding/reverse` | `geocoding/reverse/read` |
| POST | `/api/geocoding/search` | `geocoding/search/read` |
| any unmatched API route | `/api/:unknown` | `requests/unknown` |

Middleware-only terminal operations are:

| operationName | category | Condition |
|---|---|---|
| `requests/validation/validate` | Request | Invalid method/content length or oversized body |
| `auth/sessions/validate` | Request | Missing or invalid session on a protected route |

Semantic operations not introduced by route mapping are:

| operationName | category |
|---|---|
| `auth/account/create` | Application |
| `auth/provider/link` | Application |
| `auth/session/create` | Application |
| `auth/session/delete` | Application |
| `auth/passkey/create` | Application |
| `auth/passkey/delete` | Application |
| `auth/account/upgrade` | Application |
| `auth/provider/revoke` | Application |

## Privacy and safe metadata

Treat logs as operational records, not a copy of application state.

Allowed:

- Middleware-controlled top-level `userId`, `resourceId`, `traceId`, and `spanId`.
- Stable route templates, status, method, duration, and configured limits.
- Aggregate counts, booleans, bounded enums such as provider type or transition stage, and safe upstream status codes.

Do not add arbitrary entity IDs, arrays of IDs, or user-supplied identifiers to `resultDescription` or `properties`. The middleware-generated `resourceId` is the controlled place for the current outing or account scope. IDs are pseudonymous data and should not be repeated merely because they are internal.

Never log:

- Session tokens, cookies, authorization headers, OAuth callback URLs, authorization codes, passkey credential IDs, challenges, or provider credentials.
- Email addresses, profile URLs, filenames, notes, outing/location names, species names or arrays, CSV contents, image data, or other user-authored content.
- Request/response bodies, provider payloads, database/provider exception messages, stack traces, or raw error objects.
- Outbound geocoding URLs, place queries, coordinates, or the provider key.

Geocoding uses POST JSON so place queries and coordinates do not enter incoming URLs. Automatic traces remain disabled because outbound fetch spans can retain complete URLs, including provider keys or user-supplied query data.

Write `resultDescription` first. It should state the attempted operation, the known durable state, and the next action without sensitive data. Prefer:

```text
Outing, observations, and photos were deleted; post-delete dex recomputation failed
```

Avoid raw exception text or an ID-heavy sentence. Use the trace ID for correlation and a separate safe `Application` event when a durable boundary needs to be queryable. A failure description should not claim rollback when the code may already have committed.

## Required implementation practices

1. Bind the route once with `createRouteResponder(log, operationName, category)`.
2. Return `route.complete(response, resultDescription)` for successful/redirect outcomes and `route.fail(status, body, resultDescription)` for expected failures.
3. Do not emit a route completion log; middleware owns the single terminal `Request` event.
4. Use `route.info()` only for a result-less start/fallback marker. Use `route.succeeded()` or `route.failed()` for durable outcomes so `resultType` is explicit. External/multi-step work uses start+outcome; atomic committed hooks emit only an outcome.
5. Put the useful safe fact in `resultDescription`. Do not rely on `route.fail` properties; they are discarded by the response-header transport.
6. Extend `resourceId` only through `withResourceId` and avoid duplicating middleware's auto-scoped outing segment.
7. Propagate `traceparent` on outbound WingDex calls.
8. Expose only safe expected 4xx details. Never surface or log raw 5xx/provider/database content.

## Pre-deployment validation

### 1. Local Explorer

Local Explorer is the primary validation workflow. Start the normal development stack:

```bash
npm run dev
```

Wrangler runs on port `8787` by default and enables Local Explorer/local observability by default. The read-only query endpoint is:

```text
http://localhost:8787/cdn-cgi/local/explorer/api/local/observability/query
```

If a different Wrangler port is configured, use the Local Explorer API URL printed at startup. The endpoint accepts only `SELECT`/`WITH` SQL over the `logs` and `spans` tables. In Wrangler 4.119, `logs` has the columns `trace_id`, `span_id`, `seq`, `ts_ms`, `level`, `message`, `operation`, and `created_at`. `message` is a JSON-encoded array of console arguments. WingDex passes its event object as the first argument, so select events where `json_type(message, '$[0]') = 'object'` and read fields below `$[0]`.

Generate the account/data flow being changed, then begin with the complete structured event objects:

```bash
curl -sS -X POST \
  http://localhost:8787/cdn-cgi/local/explorer/api/local/observability/query \
  -H 'Content-Type: application/json' \
  -d '{"sql":"SELECT json_extract(message, '\''$[0]'\'') AS event FROM logs WHERE json_type(message, '\''$[0]'\'') = '\''object'\'' ORDER BY ts_ms DESC LIMIT 20"}'
```

Use these read-only queries in Local Explorer to validate WingDex behavior.

Recent WingDex events:

```sql
SELECT
  json_type(message, '$[0]') AS argument_type,
  json_extract(message, '$[0]') AS event,
  json_extract(message, '$[0].properties."http.route"') AS http_route
FROM logs
WHERE json_type(message, '$[0]') = 'object'
  AND json_extract(message, '$[0].operationName') IS NOT NULL
ORDER BY ts_ms DESC
LIMIT 50;
```

Ordered event sequence for one trace:

```sql
WITH wingdex AS (
  SELECT
    seq,
    ts_ms,
    json_extract(message, '$[0].time') AS time,
    json_extract(message, '$[0].traceId') AS trace_id,
    json_extract(message, '$[0].category') AS category,
    json_extract(message, '$[0].operationName') AS operation_name,
    json_extract(message, '$[0].resultType') AS result_type,
    json_extract(message, '$[0].resultDescription') AS result_description
  FROM logs
  WHERE json_type(message, '$[0]') = 'object'
)
SELECT *
FROM wingdex
WHERE trace_id = ?
ORDER BY ts_ms, seq;
```

Supply the trace ID through the request body's `params` array, for example `{"sql":"SELECT ... WHERE trace_id = ?","params":["TRACE_ID"]}`. Keep values out of the SQL string.

Operation/category event counts:

```sql
WITH wingdex AS (
  SELECT
    json_extract(message, '$[0].category') AS category,
    json_extract(message, '$[0].operationName') AS operation_name
  FROM logs
  WHERE json_type(message, '$[0]') = 'object'
)
SELECT category, operation_name, COUNT(*) AS event_count
FROM wingdex
WHERE operation_name IS NOT NULL
GROUP BY category, operation_name
ORDER BY category, operation_name;
```

Traces that do not have exactly one terminal Request event:

```sql
WITH wingdex AS (
  SELECT
    json_extract(message, '$[0].traceId') AS trace_id,
    json_extract(message, '$[0].category') AS category,
    json_extract(message, '$[0].operationName') AS operation_name
  FROM logs
  WHERE json_type(message, '$[0]') = 'object'
), grouped AS (
  SELECT
    trace_id,
    SUM(CASE WHEN category = 'Request' THEN 1 ELSE 0 END) AS request_events,
    COUNT(*) AS wingdex_events
  FROM wingdex
  WHERE operation_name IS NOT NULL
  GROUP BY trace_id
)
SELECT *
FROM grouped
WHERE request_events <> 1;
```

Successful health probes are absent by design, so they cannot appear as zero-event trace rows. A verified direct WingDex event has `argument_type = object`, while Cloudflare's default **Message** may still be blank. A representative two-transition flow has the category sequence `Application`, `Application`, `Request`; verify the flow's ordered `Application` events are followed by its single terminal `Request` event. Third-party string warnings are not WingDex events.

Keep span inspection separate from log inspection. The `spans` table has an `attributes` JSONB column, and `json(attributes)` applies to spans only. Local Explorer may expose local request spans for development inspection. Production/preview Cloudflare trace export remains disabled by `wrangler.toml`; trace correlation in retained WingDex logs is through `traceId` and `spanId` fields.

### 2. Preview live tail

After local sequence/category checks pass, deploy preview and stream newly emitted events:

```bash
npx wrangler tail -e preview --format json
```

Exercise the changed flow while the tail is connected. Confirm route templates, one terminal `Request`, expected transition events, blank/default Message behavior, and absence of sensitive data. Tail is live-only and is not a retained-history query.

### 3. Retained history

Use the Cloudflare dashboard Workers Logs view for retained preview or production history. Wrangler OAuth credentials can stream `wrangler tail`, but they cannot query the historical Workers Telemetry API. Do not treat a failed historical API query from Wrangler credentials as missing logs; use the dashboard, or a separately authorized analytics integration, for historical investigation.

## Environment summary

| Environment | Level/format | Validation surface |
|---|---|---|
| Local | `debug`, optionally `pretty` | Local Explorer first; terminal strings only for human scanning |
| Preview | `info`, structured objects | Live `wrangler tail -e preview --format json`, then dashboard history |
| Production | `info`, structured objects | Cloudflare dashboard retained logs |

Preview and production have `observability.enabled = true`, `invocation_logs = false`, and traces disabled. This leaves WingDex's structured events as the authoritative request and business-transition record.
