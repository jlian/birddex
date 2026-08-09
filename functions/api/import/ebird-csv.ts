import { computeDex } from '../../lib/dex-query'
import { detectImportConflicts, parseEBirdCSV, type ImportPreview } from '../../lib/ebird'
import { createRouteResponder } from '../../lib/log'

type EncodedPreview = ImportPreview & { previewId: string }

const MAX_CSV_SIZE_BYTES = 10 * 1024 * 1024

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}

function encodePreviewId(preview: ImportPreview): string {
  const json = JSON.stringify(preview)
  const bytes = new TextEncoder().encode(json)
  // Build the binary string via an array to avoid O(n²) string concatenation.
  const chars = new Array<string>(bytes.length)
  for (let i = 0; i < bytes.length; i++) {
    chars[i] = String.fromCharCode(bytes[i])
  }
  return btoa(chars.join(''))
}

export const onRequestPost: PagesFunction<Env> = async context => {
  const userId = (context.data as { user?: { id?: string } }).user?.id
  const route = createRouteResponder((context.data as RequestData).log, 'import/ebirdCsv/import', 'Application')
  if (!userId) {
    return route.fail(401, 'Unauthorized', 'Authentication is required to preview an eBird import')
  }

  let formData: FormData
  try {
    formData = await context.request.formData()
    } catch {
    return route.fail(400, 'Invalid form payload', 'Could not parse request body as multipart/form-data; ensure the request uses multipart encoding with a file field')
  }

  const file = formData.get('file')
  if (!(file instanceof File)) {
    return route.fail(400, 'Missing CSV file', 'No CSV file found in the file form field; include a file field with the eBird CSV export')
  }

  if (file.size > MAX_CSV_SIZE_BYTES) {
    return route.fail(413, 'CSV file too large (max 10MB)', `CSV file is ${file.size} bytes, exceeding the ${MAX_CSV_SIZE_BYTES}-byte limit; try exporting a smaller date range from eBird`, { fileSize: file.size, limit: MAX_CSV_SIZE_BYTES })
  }

  const profileTimezone = formData.get('profileTimezone')
  let stage = 'read the uploaded CSV file'
  try {
    const csvContent = await file.text()
    stage = 'parse the uploaded eBird CSV'
    const previews = parseEBirdCSV(csvContent, typeof profileTimezone === 'string' ? profileTimezone : undefined)

    stage = 'read the existing dex for conflict detection'
    const existingDexRows = await computeDex(context.env.DB, userId)
    const existingDex = new Map(existingDexRows.map(row => [row.speciesName, row]))
    const withConflicts = detectImportConflicts(previews, existingDex)

    const previewsWithIds: EncodedPreview[] = withConflicts.map(preview => ({
    ...preview,
    previewId: encodePreviewId(preview),
    }))

    const summary = {
    total: previewsWithIds.length,
    new: previewsWithIds.filter(preview => preview.conflict === 'new').length,
    duplicates: previewsWithIds.filter(preview => preview.conflict === 'duplicate').length,
    updates: previewsWithIds.filter(preview => preview.conflict === 'update_dates').length,
    }

    return route.complete(
      Response.json({ previews: previewsWithIds, summary }),
      `Parsed uploaded eBird CSV into ${countLabel(summary.total, 'preview')}: ${countLabel(summary.new, 'new preview')}, ${countLabel(summary.duplicates, 'duplicate')}, and ${countLabel(summary.updates, 'date update')}`,
    )
    } catch {
      return route.fail(500, 'Internal server error', `eBird import preview failed during stage: ${stage}`)
  }
}
