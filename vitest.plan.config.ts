/**
 * Config for the one-off backfill plan builder in scripts/.
 *
 * Deliberately separate from vitest.config.ts: the plan builder is an
 * operational step, not a test, and including it in the normal suite made CI
 * fail on a clean checkout where its input file does not exist.
 */
import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: {
    alias: { '@': resolve(__dirname, './src') },
  },
  test: {
    include: ['scripts/build-species-code-plan.mts'],
    environment: 'node',
  },
})
