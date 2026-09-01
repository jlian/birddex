/**
 * Schema-capability helpers for graceful migration gating.
 *
 * Cloudflare D1 (SQLite) doesn't support IF NOT EXISTS on ALTER TABLE,
 * so endpoints probe PRAGMA table_info to decide whether newer columns
 * are available before referencing them in queries.
 *
 * Capabilities are intentionally not cached. A worker version is deployed
 * before migrations, so an isolate can observe the old schema first and must
 * see the new columns immediately after the migration completes.
 */

export interface SchemaDB {
  prepare(sql: string): {
    bind(...args: unknown[]): {
      all<T>(): Promise<{ results: T[] }>
    }
  }
}

export async function getTableColumnNames(db: SchemaDB, table: string): Promise<Set<string>> {
  const info = await db.prepare(`PRAGMA table_info('${table}')`).bind().all<{ name: string }>()
  return new Set((info?.results ?? []).map(column => column.name))
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
