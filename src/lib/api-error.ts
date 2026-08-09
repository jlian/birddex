const TRACE_ID_PATTERN = /^(?!0{32}$)[0-9a-f]{32}$/i
const MAX_ERROR_BODY_BYTES = 512
const MAX_ERROR_MESSAGE_LENGTH = 240

function sanitizeText(value: string, maxLength: number): string {
  const printableValue = Array.from(value, character => {
    const code = character.charCodeAt(0)
    return code <= 31 || code === 127 ? ' ' : character
  }).join('')

  return printableValue
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
}

export function extractTraceId(response: Response): string | undefined {
  const traceId = response.headers.get('X-Trace-Id')?.trim()
  return traceId && TRACE_ID_PATTERN.test(traceId) ? traceId.toLowerCase() : undefined
}

async function readSafeClientError(response: Response): Promise<string | undefined> {
  if (response.status < 400 || response.status >= 500) return undefined
  if (!response.headers.get('Content-Type')?.toLowerCase().startsWith('text/plain')) return undefined
  if (!response.body) return undefined

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let byteLength = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      byteLength += value.byteLength
      if (byteLength > MAX_ERROR_BODY_BYTES) {
        await reader.cancel()
        return undefined
      }
      chunks.push(value)
    }
  } catch {
    return undefined
  }

  const bytes = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }

  const message = sanitizeText(new TextDecoder().decode(bytes), MAX_ERROR_MESSAGE_LENGTH)
  return message || undefined
}

export class WingDexApiError extends Error {
  readonly status: number
  readonly statusText: string
  readonly traceId?: string

  constructor(options: { status: number; statusText: string; traceId?: string; message: string }) {
    super(options.message)
    this.name = 'WingDexApiError'
    this.status = options.status
    this.statusText = options.statusText
    this.traceId = options.traceId
  }
}

export function getWingDexApiErrorMessage(error: unknown, fallbackMessage: string): string {
  return error instanceof WingDexApiError ? error.message : fallbackMessage
}

export async function assertWingDexApiResponse(
  response: Response,
  fallbackMessage = 'Request failed',
): Promise<void> {
  if (response.ok) return

  const bodyMessage = await readSafeClientError(response)
  const safeFallback = sanitizeText(fallbackMessage, MAX_ERROR_MESSAGE_LENGTH) || 'Request failed'
  throw new WingDexApiError({
    status: response.status,
    statusText: sanitizeText(response.statusText, 80),
    traceId: extractTraceId(response),
    message: bodyMessage ?? `${safeFallback} (HTTP ${response.status})`,
  })
}