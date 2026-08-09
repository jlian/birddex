import demoCsv from '@/assets/ebird-import.csv?raw'
import { fetchWithLocalAuthRetry } from '@/lib/local-auth-fetch'
import { assertWingDexApiResponse } from '@/lib/api-error'
import type { WingDexDataStore } from '@/hooks/use-wingdex-data'

export async function loadDemoData(data: WingDexDataStore): Promise<void> {
  data.clearAllData()

  const formData = new FormData()
  formData.append('file', new Blob([demoCsv], { type: 'text/csv' }), 'demo.csv')

  const previewRes = await fetchWithLocalAuthRetry('/api/import/ebird-csv', {
    method: 'POST',
    credentials: 'include',
    body: formData,
  })
  await assertWingDexApiResponse(previewRes, 'Preview failed')

  const { previews } = await previewRes.json() as { previews: Array<{ previewId: string }> }

  const confirmRes = await fetchWithLocalAuthRetry('/api/import/ebird-csv/confirm', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ previewIds: previews.map((p) => p.previewId) }),
  })
  await assertWingDexApiResponse(confirmRes, 'Confirmation failed')

  await data.refresh()
}
