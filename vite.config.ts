import { cloudflare } from '@cloudflare/vite-plugin'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import { execSync } from 'child_process'
import { homedir } from 'os'
import { join } from 'path'
import packageJson from './package.json'

function gitInfo() {
  try {
    const hash = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim()
    const branch = execSync('git branch --show-current', { encoding: 'utf-8' }).trim()
    return { hash, branch }
  } catch {
    return { hash: '', branch: '' }
  }
}

const git = gitInfo()
const persistPath = process.env.WINGDEX_WRANGLER_STATE_PATH
  || join(homedir(), '.cache/wingdex/wrangler-state')

function serveGzipFilesAsRawBytes(): Plugin {
  return {
    name: 'wingdex-raw-gzip-assets',
    enforce: 'pre',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url || '/', 'http://localhost').pathname
        if (!pathname.endsWith('.gz')) {
          next()
          return
        }

        const setHeader = response.setHeader.bind(response)
        response.setHeader = (name, value) => {
          if (name.toLowerCase() === 'content-encoding') return response
          return setHeader(name, value)
        }
        next()
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, import.meta.dirname, '')
  return {
    define: {
      APP_VERSION: JSON.stringify(packageJson.version),
      __GIT_HASH__: JSON.stringify(git.hash),
      __GIT_BRANCH__: JSON.stringify(git.branch),
    },
    plugins: [
      serveGzipFilesAsRawBytes(),
      react(),
      tailwindcss(),
      cloudflare({
        persistState: { path: persistPath },
        remoteBindings: process.env.CLOUDFLARE_REMOTE_BINDINGS !== 'false',
      }),
    ],
    server: {
      host: !!env.VITE_SERVER_HOST,
      allowedHosts: env.VITE_ALLOWED_HOSTS?.split(',').filter(Boolean) ?? [],
      forwardConsole: true,
      watch: {
        // ml/ is the research tree: 148 GB across 455k files on tomahawk, and
        // untracked on this branch. Watching it starves the dev server of file
        // handles. gitignore keeps it out of git; this keeps it out of chokidar.
        ignored: ['**/.wrangler/**', '**/.tmp/**', '**/ml/**'],
      },
    },
    resolve: {
      tsconfigPaths: true,
    },
  }
})
