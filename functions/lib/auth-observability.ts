import type { Logger } from './log'

export function logPasskeyAccountUpgrade(log: Logger | undefined): void {
  log?.info('auth/account/upgrade', {
    category: 'Application',
    resultType: 'Succeeded',
    resultDescription: 'Upgraded the temporary anonymous account to a persistent passkey-backed WingDex account',
  })
}
