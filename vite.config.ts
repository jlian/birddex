import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { execSync } from 'child_process'
import packageJson from './package.json'

const apiPort = process.env.API_PORT || '8787'

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
      react(),
      tailwindcss(),
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
      proxy: {
        '/api': `http://localhost:${apiPort}`,
      },
    },
    resolve: {
      tsconfigPaths: true,
    },
  }
});
