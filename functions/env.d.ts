interface Env {
  DB: D1Database
  BETTER_AUTH_URL: string
  BETTER_AUTH_SECRET: string
  GITHUB_CLIENT_ID: string
  GITHUB_CLIENT_SECRET: string
  APPLE_CLIENT_ID: string
  APPLE_CLIENT_SECRET: string
  /** Client-secret JWT whose subject is the native bundle ID app.wingdex. */
  APPLE_APP_CLIENT_SECRET?: string
  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
  CF_ACCOUNT_ID: string
  AI_GATEWAY_ID: string
  CF_AIG_TOKEN: string
  OPENAI_API_KEY: string
  OPENAI_MODEL: string
  OPENAI_MODEL_STRONG?: string
  /** OSM place polygons (PMTiles) for local reverse geocoding, ODbL 1.0. */
  PLACES?: Pick<R2Bucket, 'get'>
  /**
   * Self-hosted forward place search: an FTS5 index over the same OSM corpus
   * the reverse archive uses, ODbL 1.0. See scripts/osm-places.
   *
   * Optional so the Worker still boots before the index is published, and so
   * preview can run without it. `searchPlaces` reports the binding as
   * unconfigured rather than throwing, which the route maps to a 503.
   */
  PLACES_SEARCH?: D1Database
  GEOAPIFY_KEY: string
  /** Burst limiter for the Geoapify-backed place-search route. See [[ratelimits]] in wrangler.toml. */
  GEOCODING_LIMITER: RateLimit
  /** Abuse guard for local PMTiles reverse lookups and their R2 reads. */
  REVERSE_GEOCODING_LIMITER: RateLimit
  /** Burst limiter for the eBird CSV import routes. See [[ratelimits]] in wrangler.toml. */
  IMPORT_LIMITER: RateLimit
  AI_DAILY_LIMIT_IDENTIFY?: string
  AI_DAILY_LIMIT_SUGGEST?: string
  /** Set to "false" to preserve merge intents without finalizing them. */
  ACCOUNT_MERGE_ENABLED?: string
  TRUSTED_ORIGINS?: string
  /** @deprecated Use LOG_LEVEL instead. Kept for backwards compat (DEBUG=1 maps to LOG_LEVEL=debug). */
  DEBUG?: string
  /** Log level: trace, debug, info (default), warn/warning, error, critical. */
  LOG_LEVEL?: string
  /** Log format: 'pretty' for compact terminal output, omit for JSON. */
  LOG_FORMAT?: string
}

/** Shape of context.data populated by _middleware.ts. */
interface RequestData extends Record<string, unknown> {
  user?: { id?: string; isAnonymous?: boolean }
  session?: { id: string }
  traceId?: string
  spanId?: string
  traceFlags?: string
  log?: import('./lib/log').Logger
  operationName?: string
  category?: import('./lib/log').Category
  /** True when middleware already appended an entity segment (e.g. outings/{id}) to resourceId from URL params. Handlers should NOT call withResourceId for the same entity. */
  autoScopedResourceId?: boolean
}
