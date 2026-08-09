/**
 * Static compliance tests for OBSERVABILITY.md guidelines.
 *
 * These tests read handler source files as text and verify structural
 * patterns that enforce the observability contract. They catch regressions
 * like missing createRouteResponder, missing route.complete(), or route.fail()
 * without detail arguments - issues that would otherwise only surface
 * during code review.
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import { join, relative, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const FUNCTIONS_API_DIR = join(__dirname, '../../functions/api')
const MIDDLEWARE_PATH = join(__dirname, '../../functions/_middleware.ts')

/** Recursively list all .ts files under a directory. */
function listTsFiles(dir: string): string[] {
  const results: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...listTsFiles(fullPath))
    } else if (entry.name.endsWith('.ts')) {
      results.push(fullPath)
    }
  }
  return results
}

/** Handler files that are exempt from createRouteResponder. */
const EXEMPT_HANDLERS = new Set([
  'auth/[[path]].ts',  // Better Auth catch-all, not a route handler we instrument
])

function getHandlerFiles(): Array<{ path: string; rel: string; content: string }> {
  return listTsFiles(FUNCTIONS_API_DIR)
    .filter(f => !f.includes('_middleware'))
    .filter(f => !f.endsWith('.test.ts'))
    .map(f => ({
      path: f,
      rel: relative(FUNCTIONS_API_DIR, f),
      content: readFileSync(f, 'utf-8'),
    }))
}

describe('handler instrumentation compliance', () => {
  const handlers = getHandlerFiles()
  const instrumented = handlers.filter(h => !EXEMPT_HANDLERS.has(h.rel))

  it('every non-exempt handler uses createRouteResponder', () => {
    const missing = instrumented.filter(h => !h.content.includes('createRouteResponder'))
    expect(missing.map(h => h.rel)).toEqual([])
  })

  it('every non-exempt handler uses route.complete() for terminal success responses', () => {
    const missing = instrumented.filter(h => !h.content.includes('route.complete('))
    expect(missing.map(h => h.rel)).toEqual([])
  })

  it('no handler uses raw log?.warn() or log?.error() (should use route.fail)', () => {
    const violations = instrumented.filter(h => {
      // Match raw log calls but exclude:
      // - route.log?.warn (escape hatch)
      // - lib files (bird-id.ts uses logger directly)
      const lines = h.content.split('\n')
      return lines.some(line =>
        (line.includes('log?.warn(') || line.includes('log?.error(')) &&
        !line.includes('route.log?.') &&
        !line.trim().startsWith('//')
      )
    })
    expect(violations.map(h => h.rel)).toEqual([])
  })

  it('every catch block calls route.fail() or route.log', () => {
    const violations: string[] = []
    for (const h of instrumented) {
      const lines = h.content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('} catch')) {
          // Look ahead up to 15 lines for route.fail or route.log
          const block = lines.slice(i, i + 16).join('\n')
          if (!block.includes('route.fail(') && !block.includes('route.log?.')) {
            // Allow: inner catch that rethrows, utility function catch (returns value)
            if (block.includes('throw ') || block.includes('return null') || block.includes('return false')) {
              continue
            }
            violations.push(`${h.rel}:${i + 1}`)
          }
        }
      }
    }
    expect(violations).toEqual([])
  })

  it('URL-param routes do not duplicate withResourceId (middleware already scopes)', () => {
    // Middleware extractEntitySegment already appends outings/{id} for these routes.
    // Handlers must NOT call withResourceId('outings/...') again.
    const urlParamRoutes = [
      'data/outings/[id].ts',
      'export/outing/[id].ts',
    ]
    const violations: string[] = []
    for (const h of handlers) {
      if (!urlParamRoutes.includes(h.rel)) continue
      if (h.content.includes("withResourceId(`outings/") || h.content.includes("withResourceId('outings/")) {
        violations.push(`${h.rel}: has withResourceId('outings/...') but middleware already scopes via extractEntitySegment`)
      }
    }
    expect(violations).toEqual([])
  })

  it('every route.fail() has a detail argument (3rd arg)', () => {
    const violations: string[] = []
    for (const h of handlers) {
      const lines = h.content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        // Match route.fail(NNN, 'body') without a 3rd arg
        // Pattern: route.fail(number, 'string') with no comma after closing quote+paren
        const match = line.match(/route\.fail\(\d+,\s*'[^']*'\s*\)/)
        if (match) {
          violations.push(`${h.rel}:${i + 1}: ${line.trim()}`)
        }
      }
    }
    expect(violations).toEqual([])
  })
})

describe('ROUTE_MAP compliance', () => {
  const middleware = readFileSync(MIDDLEWARE_PATH, 'utf-8')

  it('every operationName follows resourceType/subType/verb format', () => {
    const opNameRegex = /op:\s*'([^']+)'/g
    let match
    const invalid: string[] = []
    while ((match = opNameRegex.exec(middleware)) !== null) {
      const op = match[1]
      // Must have at least 2 slashes: type/sub/verb
      // Exception: 'requests/unknown' is the low-cardinality fallback
      if (op !== 'requests/unknown' && op.split('/').length < 3) {
        invalid.push(op)
      }
    }
    expect(invalid).toEqual([])
  })

  it('every category is Audit, Application, or Request', () => {
    const catRegex = /category:\s*'([^']+)'/g
    let match
    const invalid: string[] = []
    while ((match = catRegex.exec(middleware)) !== null) {
      const cat = match[1]
      if (!['Audit', 'Application', 'Request'].includes(cat)) {
        invalid.push(cat)
      }
    }
    expect(invalid).toEqual([])
  })

  it('fallback operationName is low-cardinality (no dynamic paths)', () => {
    // The resolveOperation fallback should be a fixed string, not include pathname
    expect(middleware).toContain("return { op: 'requests/unknown'")
  })

  it('request metadata uses route templates rather than raw pathnames', () => {
    expect(middleware).toContain("route: '/api/data/outings/:id'")
    expect(middleware).toContain("'http.route': routeTemplate")
    expect(middleware).not.toContain("'http.route': pathname")
  })

  it('middleware strips private route outcome transport headers before responding', () => {
    expect(middleware).toContain('response.headers.delete(RESULT_DESCRIPTION_HEADER)')
    expect(middleware).toContain('response.headers.delete(RESULT_TYPE_HEADER)')
  })

  it('middleware honors route-supplied semantic resultType override when present', () => {
    expect(middleware).toContain("const resultType = outcome?.resultType || (status < 400 ? 'Succeeded' : 'Failed')")
  })
})

describe('client logger compliance', () => {
  const clientLog = readFileSync(join(__dirname, '../lib/client-log.ts'), 'utf-8')

  it('client log levels use capitalized names matching server', () => {
    // Verify the emit function uses capitalized levels
    expect(clientLog).toContain("emit('Info'")
    expect(clientLog).toContain("emit('Warning'")
    expect(clientLog).toContain("emit('Error'")
    expect(clientLog).toContain("emit('Debug'")
    // Should NOT use lowercase
    expect(clientLog).not.toMatch(/emit\('info'/)
    expect(clientLog).not.toMatch(/emit\('warn'/)
    expect(clientLog).not.toMatch(/emit\('error'/)
  })

  it('logClientFailure operationNames use slash convention', () => {
    // Read use-wingdex-data.ts to verify operationNames
    const hookFile = readFileSync(join(__dirname, '../hooks/use-wingdex-data.ts'), 'utf-8')
    const failureCalls = hookFile.match(/logClientFailure\('([^']+)'/g) || []
    const names = failureCalls.map(c => c.match(/logClientFailure\('([^']+)'/)?.[1]).filter(Boolean)
    for (const name of names) {
      expect(name).toMatch(/\//)  // Must contain slash
      expect(name).not.toMatch(/\./)  // Must NOT contain dot
    }
  })
})
