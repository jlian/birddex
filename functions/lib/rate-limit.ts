/**
 * Rate limit key for a metered request. Registered accounts get their own
 * budget; anonymous sessions share one per IP, because they can be minted
 * without limit and a per-account key would hand out a fresh allowance each time.
 */
export function rateLimitKey(
  user: { id?: string; isAnonymous?: boolean } | undefined,
  request: Request,
): string {
  if (user?.isAnonymous) {
    return `ip:${request.headers.get('cf-connecting-ip') || 'unknown'}`
  }
  return `user:${user?.id || 'unknown'}`
}
