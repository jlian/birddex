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
  const info = await db.prepare(`PRAGMA table_info('${table}')`).all<{ name: string }>()
  const names = new Set(info.results.map(column => column.name))
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
