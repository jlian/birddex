/**
 * SPIKE (#271): move an anonymous user's data onto the durable user created
 * during passkey registration.
 *
 * Why this is hand-rolled rather than delegated to the anonymous plugin: the
 * plugin's onLinkAccount hook only runs for a fixed list of paths, and
 * /passkey/verify-registration is not one of them (it matches
 * verify-AUTHENTICATION, not verify-REGISTRATION). On the one-ceremony signup
 * path the hook never fires, so the plugin also never deletes the anonymous
 * user for us. Both halves are ours to do.
 *
 * Ordering is load-bearing. Every user-scoped table is ON DELETE CASCADE, so
 * deleting the anonymous row first does not orphan its data, it destroys it.
 * Re-point every table, then delete.
 */

/** Tables whose rows belong to a user and must follow them to the new id. */
export const USER_SCOPED_TABLES = [
  'observation',
  'outing',
  'photo',
  'dex_meta',
  'ai_daily_usage',
] as const

export interface MigrationResult {
  /** Rows moved, per table, for logging and for asserting in tests. */
  moved: Record<string, number>
  total: number
}

/**
 * Re-points every user-scoped row from `fromUserId` to `toUserId`.
 *
 * Does NOT delete the anonymous user: the caller decides that, and must only do
 * it after this resolves. Returns per-table counts so a caller can log what
 * actually moved rather than assuming.
 */
export async function migrateAnonymousData(
  db: D1Database,
  fromUserId: string,
  toUserId: string,
): Promise<MigrationResult> {
  if (!fromUserId || !toUserId) throw new Error('migrateAnonymousData requires both user ids')
  if (fromUserId === toUserId) return { moved: {}, total: 0 }

  const moved: Record<string, number> = {}
  let total = 0

  // Table names are from the module-level allowlist above, never from input.
  for (const table of USER_SCOPED_TABLES) {
    const result = await db
      .prepare(`UPDATE ${table} SET userId = ? WHERE userId = ?`)
      .bind(toUserId, fromUserId)
      .run()
    const changes = result.meta?.changes ?? 0
    moved[table] = changes
    total += changes
  }

  return { moved, total }
}
