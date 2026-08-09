import { describe, expect, it } from 'vitest'
import { RESULT_DESCRIPTION_HEADER } from '../../../lib/log'
import { onRequestGet } from './start'

describe('mobile OAuth start', () => {
  it('does not echo an unsupported provider query value', async () => {
    const rawProvider = 'private-user-controlled-provider'
    const context = {
      request: new Request(`https://wingdex.example/api/auth/mobile/start?provider=${rawProvider}`),
      env: {},
      data: {},
    } as unknown as Parameters<typeof onRequestGet>[0]

    const response = await onRequestGet(context) as Response
    const body = await response.text()
    const resultDescription = response.headers.get(RESULT_DESCRIPTION_HEADER)

    expect(response.status).toBe(400)
    expect(body).toBe('Unsupported provider parameter')
    expect(resultDescription).toBe('Unsupported OAuth provider; allowed providers are github, apple, and google')
    expect(`${body} ${resultDescription}`).not.toContain(rawProvider)
  })
})