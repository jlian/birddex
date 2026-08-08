import { describe, expect, it } from 'vitest'
import { createAuth } from './auth'

describe('auth routes', () => {
  it('does not expose Better Auth built-in account deletion', async () => {
    const request = new Request('https://wingdex.app/api/auth/delete-user', { method: 'POST' })
    const auth = createAuth({
      BETTER_AUTH_SECRET: 'test-secret-that-is-at-least-32-characters',
      BETTER_AUTH_URL: 'https://wingdex.app',
      DB: {} as D1Database,
    } as Env, { request })

    const context = await auth.$context

    expect(context.options.user?.deleteUser?.enabled).toBe(false)
  })
})
