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

const cache = new Map<string, Set<string>>()

export async function getTableColumnNames(db: D1Database, table: string): Promise<Set<string>> {
  const cached = cache.get(table)
  if (cached) return cached
  // A stub or partial D1 that cannot answer PRAGMA must not take the request
  // down. Treat an unanswerable probe as "no optional columns", which is the
  // same conservative answer as a database that has not run the migration.
  let names: Set<string>
  try {
    const info = await db.prepare(`PRAGMA table_info('${table}')`).all<{ name: string }>()
    names = new Set((info?.results ?? []).map(column => column.name))
  } catch {
    names = new Set<string>()
  }
  cache.set(table, names)
  return names
}

export async function getOutingColumnNames(db: D1Database): Promise<Set<string>> {
  return getTableColumnNames(db, 'outing')
}

export async function hasObservationColumn(db: D1Database, column: string): Promise<boolean> {
  const names = await getTableColumnNames(db, 'observation')
  return names.has(column)
}

export async function hasDexMetaColumn(db: D1Database, column: string): Promise<boolean> {
  const names = await getTableColumnNames(db, 'dex_meta')
  return names.has(column)
}
