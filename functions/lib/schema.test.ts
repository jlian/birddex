import { describe, expect, it } from 'vitest'
import { getTableColumnNames, type SchemaDB } from './schema'

describe('schema capability probes', () => {
  it('observes columns added after an earlier probe in the same isolate', async () => {
    let names = ['userId', 'speciesName']
    const db: SchemaDB = {
      prepare() {
        return {
          bind() {
            return {
              async all<T>() {
                return { results: names.map(name => ({ name })) as T[] }
              },
            }
          },
        }
      },
    }

    await expect(getTableColumnNames(db, 'dex_meta')).resolves.not.toContain('groupKey')
    names = [...names, 'groupKey', 'speciesCode']
    await expect(getTableColumnNames(db, 'dex_meta')).resolves.toContain('groupKey')
  })
})
