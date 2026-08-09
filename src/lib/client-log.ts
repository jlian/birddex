/**
 * Lightweight client-side structured logger for the web app.
 *
 * Mirrors the server schema in `functions/lib/log.ts` so production logs from
 * both tiers share the same shape (operationName, resultType, resultDescription,
 * properties, etc.). Used by web mutations to replace silent
 * `.catch(() => undefined)` swallows.
 *
 * Emits only to the local browser console via console.error (warn/error) or
 * console.log (info/debug).
 */

import { WingDexApiError } from '@/lib/api-error'

export type ClientLogLevel = 'Info' | 'Warning' | 'Error' | 'Debug'
export type ClientResultType = 'Succeeded' | 'Failed'

export interface ClientLogFields {
  resultType?: ClientResultType
  resultSignature?: number | string
  resultDescription?: string
  properties?: Record<string, unknown>
}

function emit(level: ClientLogLevel, operationName: string, fields?: ClientLogFields): void {
  if (level === 'Debug' && !import.meta.env.DEV) return
  const entry: Record<string, unknown> = {
    time: new Date().toISOString(),
    level,
    tier: 'web',
    operationName,
  }
  if (fields?.resultType) entry.resultType = fields.resultType
  if (fields?.resultSignature !== undefined) entry.resultSignature = fields.resultSignature
  if (fields?.resultDescription) entry.resultDescription = fields.resultDescription
  if (fields?.properties && Object.keys(fields.properties).length > 0) entry.properties = fields.properties

  const json = JSON.stringify(entry)
  if (level === 'Error' || level === 'Warning') {
    console.error(json)
  } else {
    console.log(json)
  }
}

export const clientLog = {
  info: (operationName: string, fields?: ClientLogFields) => emit('Info', operationName, fields),
  warn: (operationName: string, fields?: ClientLogFields) => emit('Warning', operationName, fields),
  error: (operationName: string, fields?: ClientLogFields) => emit('Error', operationName, fields),
  debug: (operationName: string, fields?: ClientLogFields) => emit('Debug', operationName, fields),
}

/**
 * Log a fetch/mutation failure using only safe operational metadata.
 * Typed HTTP status selects the severity, while thrown messages and response
 * bodies are intentionally excluded from structured logs. A server trace ID,
 * when present, is included only in the existing properties object.
 */
export function logClientFailure(operationName: string, err: unknown, properties?: Record<string, unknown>): void {
  const statusMatch = err instanceof Error ? /^(\d{3})\s/.exec(err.message) : null
  const resultSignature = err instanceof WingDexApiError
    ? err.status
    : statusMatch ? Number(statusMatch[1]) : undefined
  const logProperties = err instanceof WingDexApiError && err.traceId
    ? { ...properties, traceId: err.traceId }
    : properties
  const logger = resultSignature !== undefined && resultSignature >= 400 && resultSignature < 500
    ? clientLog.warn
    : clientLog.error
  logger(operationName, {
    resultType: 'Failed',
    resultSignature,
    resultDescription: resultSignature !== undefined
      ? `Client request failed with HTTP ${resultSignature}`
      : 'Client request failed; inspect the operation and browser network trace',
    properties: logProperties,
  })
}
