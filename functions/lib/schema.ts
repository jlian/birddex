/**
 * Schema-capability helpers for graceful migration gating.
 *
 * Cloudflare D1 (SQLite) doesn't support IF NOT EXISTS on ALTER TABLE,
 * so endpoints probe PRAGMA table_info to decide whether newer columns
 * are available before referencing them in queries.
 *
 * Results are cached per isolate (module-scoped) so repeated calls
 * within the same Worker invocation avoid extra D1 round trips.
 */

const cache = new WeakMap<object, Map<string, Set<string>>>()

export interface SchemaDB {
  prepare(sql: string): {
    bind(...args: unknown[]): {
      all<T>(): Promise<{ results: T[] }>
    }
  }
}

export async function getTableColumnNames(db: SchemaDB, table: string): Promise<Set<string>> {
  const databaseCache = cache.get(db as object)
  const cached = databaseCache?.get(table)
  if (cached) return cached
  // A stub or partial D1 that cannot answer PRAGMA must not take the request
  // down. Treat an unanswerable probe as "no optional columns", which is the
  // same conservative answer as a database that has not run the migration.
  let names: Set<string>
  try {
    const info = await db.prepare(`PRAGMA table_info('${table}')`).bind().all<{ name: string }>()
    names = new Set((info?.results ?? []).map(column => column.name))
  } catch {
    // Do NOT cache a failed probe. A stub database that cannot answer PRAGMA at
    // all is answered conservatively on every call, which costs one cheap query
    // per request. Caching it instead would let one transient D1 error pin the
    // isolate to "no optional columns" for its whole lifetime, so every later
    // write would silently drop speciesCode long after the database recovered.
    // That failure is invisible and produces wrong data, which is far worse
    // than repeating a probe.
    return new Set<string>()
  }
  if (databaseCache) {
    databaseCache.set(table, names)
  } else {
    cache.set(db as object, new Map([[table, names]]))
  }
  return names
}

export async function getOutingColumnNames(db: SchemaDB): Promise<Set<string>> {
  return getTableColumnNames(db, 'outing')
}

export async function hasObservationColumn(db: SchemaDB, column: string): Promise<boolean> {
  const names = await getTableColumnNames(db, 'observation')
  return names.has(column)
}

export async function hasDexMetaColumn(db: SchemaDB, column: string): Promise<boolean> {
  const names = await getTableColumnNames(db, 'dex_meta')
  return names.has(column)
}
