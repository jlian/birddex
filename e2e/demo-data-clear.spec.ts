/**
 * Turning demo data off must remove ONLY the sample checklists.
 *
 * This used to call an unscoped clear (`DELETE FROM outing WHERE userId = ?`),
 * which was harmless only because anonymous visitors could not create real
 * records. Once they can, that same call takes the user's own sightings with
 * it, so this asserts the real outing survives.
 */
import { expect, request, test } from '@playwright/test'
import { readFileSync } from 'fs'
import path from 'path'
import { testBaseURL } from './test-server'

const API_BASE = testBaseURL

function buildCookieHeader(setCookieValues: string[]): string {
  return setCookieValues.map(value => value.split(';')[0]).join('; ')
}

test('demo clear removes sample checklists and keeps real ones', async () => {
  const api = await request.newContext({ baseURL: API_BASE })

  const signIn = await api.post('/api/auth/sign-in/anonymous', { data: {} })
  expect(signIn.status()).toBe(200)
  const cookie = buildCookieHeader(
    signIn.headersArray().filter(h => h.name.toLowerCase() === 'set-cookie').map(h => h.value),
  )
  expect(cookie).toBeTruthy()

  // Demo data: the shipped CSV, whose checklists carry the reserved prefix.
  const csv = readFileSync(path.resolve('src/assets/ebird-import.csv'))
  const preview = await api.post('/api/import/ebird-csv', {
    headers: { cookie },
    multipart: { file: { name: 'demo.csv', mimeType: 'text/csv', buffer: csv } },
  })
  expect(preview.status()).toBe(200)
  const previewIds = (await preview.json()).previews
    .map((entry: { previewId?: string }) => entry.previewId)
    .filter((id: string | undefined): id is string => !!id)
  const confirm = await api.post('/api/import/ebird-csv/confirm', {
    headers: { cookie },
    data: { previewIds },
  })
  expect(confirm.status()).toBe(200)
  const demoOutings = (await confirm.json()).imported.outings
  expect(demoOutings).toBeGreaterThan(0)

  // A real outing, created the way a user would, with no submission id.
  const realOutingId = `outing_real_${Date.now()}`
  const createReal = await api.post('/api/data/outings', {
    headers: { cookie, 'Content-Type': 'application/json' },
    data: {
      id: realOutingId,
      startTime: '2026-05-02T08:00:00.000Z',
      endTime: '2026-05-02T09:00:00.000Z',
      locationName: 'Union Bay Natural Area',
      notes: '',
      createdAt: '2026-05-02T09:05:00.000Z',
    },
  })
  expect(createReal.status()).toBeLessThan(300)

  const before = await api.get('/api/data/all', { headers: { cookie } })
  expect((await before.json()).outings.length).toBe(demoOutings + 1)

  const cleared = await api.fetch('/api/data/clear?scope=demo', { method: 'DELETE', headers: { cookie } })
  expect(cleared.status()).toBe(200)
  // Some rows were removed. The exact number is not asserted: D1 reports
  // meta.changes including cascaded observation and photo rows, not just outings.
  expect((await cleared.json()).rowsAffected).toBeGreaterThan(0)

  // The assertion that matters: the user's own outing is still there.
  const after = await api.get('/api/data/all', { headers: { cookie } })
  const remaining = (await after.json()).outings as Array<{ id: string }>
  expect(remaining.length).toBe(1)
  expect(remaining[0].id).toBe(realOutingId)

  await api.dispose()
})
