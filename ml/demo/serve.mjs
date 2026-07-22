#!/usr/bin/env node
// Minimal static server for the demo with COOP/COEP + range support.
import { createServer } from 'http'
import { readFile, stat } from 'fs/promises'
import { extname, join, resolve } from 'path'
const ROOT = resolve(process.argv[2] || '.')
const PORT = +(process.argv[3] || 8770)
const MIME = { '.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript', '.json':'application/json', '.bin':'application/octet-stream', '.onnx':'application/octet-stream', '.wasm':'application/wasm', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.png':'image/png' }
createServer(async (req,res)=>{
  try {
    let p = decodeURIComponent(req.url.split('?')[0]); if (p==='/') p='/index.html'
    const fp = join(ROOT, p)
    const st = await stat(fp)
    const buf = await readFile(fp)
    res.setHeader('Cross-Origin-Opener-Policy','same-origin')
    res.setHeader('Cross-Origin-Embedder-Policy','require-corp')
    res.setHeader('Cross-Origin-Resource-Policy','cross-origin')
    res.setHeader('Content-Type', MIME[extname(fp)] || 'application/octet-stream')
    res.setHeader('Content-Length', st.size)
    res.end(buf)
  } catch(e){ res.statusCode=404; res.end('not found') }
}).listen(PORT, ()=>console.log(`serving ${ROOT} on http://localhost:${PORT}`))
