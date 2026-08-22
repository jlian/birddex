export type AccountMergeAuthMethod = 'github' | 'google' | 'apple' | 'passkey'

export interface AccountMergeResult {
  status: 'completed'
  sourceUserId: string
  targetUserId: string
  promoted: boolean
  outings: number
  observations: number
  photos: number
}

const storageKey = 'wingdex.accountMergeToken'
const targetStorageKey = 'wingdex.accountMergeTarget'

export function pendingAccountMergeToken(): string | null {
  return typeof window === 'undefined' ? null : window.sessionStorage.getItem(storageKey)
}

export function discardPendingAccountMergeToken(): void {
  if (typeof window === 'undefined') return
  window.sessionStorage.removeItem(storageKey)
  window.sessionStorage.removeItem(targetStorageKey)
}

export function pendingAccountMergeTarget(): string | null {
  return typeof window === 'undefined' ? null : window.sessionStorage.getItem(targetStorageKey)
}

export function bindPendingAccountMergeTarget(targetUserId: string): void {
  if (typeof window === 'undefined') return
  const existingTarget = pendingAccountMergeTarget()
  if (existingTarget && existingTarget !== targetUserId) {
    throw new Error('Pending account merge belongs to another target')
  }
  window.sessionStorage.setItem(targetStorageKey, targetUserId)
}

export function discardUnboundAccountMergeToken(): void {
  if (!pendingAccountMergeTarget()) discardPendingAccountMergeToken()
}

export async function prepareAccountMerge(authMethod: AccountMergeAuthMethod): Promise<string> {
  const response = await fetch('/api/auth/merge/prepare', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ authMethod }),
  })
  if (!response.ok) throw new Error(`Account merge preparation failed (${response.status})`)
  const body = await response.json() as { token?: unknown }
  if (typeof body.token !== 'string' || body.token.length < 32) {
    throw new Error('Account merge preparation returned no token')
  }
  window.sessionStorage.setItem(storageKey, body.token)
  window.sessionStorage.removeItem(targetStorageKey)
  return body.token
}

export async function finalizeAccountMerge(token = pendingAccountMergeToken()): Promise<AccountMergeResult | null> {
  const response = await fetch('/api/auth/merge/finalize', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(token ? { token } : {}),
  })
  if (!response.ok) throw new Error(`Account merge finalization failed (${response.status})`)
  const result = await response.json() as AccountMergeResult | { status: 'none' }
  if (token) discardPendingAccountMergeToken()
  if (result.status === 'none') return null
  return result
}