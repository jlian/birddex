// Adaptive bird-ID router demo.
// Strategy:
//   - Measure download speed while streaming the model.
//   - If the model is cached / finishes downloading in time -> run BioCLIP on-device.
//   - If not yet ready when the user asks -> fall back to the server (GPT).
//   - Background prefetch fills the cache for next time.
// One shared post-processing path (taxonomy + range + gate) regardless of source.
//
// onnxruntime-web is loaded from CDN for the demo. Model + text-embedding assets
// are served locally from ./models/.

import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort.webgpu.mjs'

const MODEL_URL = './models/bioclip2_visual_int8.onnx'
const TEXT_URL = './models/text_embeds_int8.bin'
const SCALE_URL = './models/text_embeds_scale.bin'
const SPECIES_URL = './models/species.json'
const EMBED_DIM = 768
const NUM_SPECIES = 11167
const SLOW_KBPS = 2500 // if projected download < this, treat as "too slow", use GPT now
const SOFTMAX_TEMP = 0.01
const CROP_GATE = 0.6 // softmax_top1 below this => suggest manual crop
const DOM_MARGIN = 0.5

const $ = id => document.getElementById(id)
const log = (m) => { const el = $('log'); el.textContent += m + '\n'; el.scrollTop = el.scrollHeight; console.log(m) }

// ---- network hint (imperfect, Chrome/Android only) ----
function netHint() {
  const c = navigator.connection
  if (!c) return 'navigator.connection: unavailable (Safari/FF) — will measure directly'
  return `navigator.connection: ${c.effectiveType || '?'}, downlink≈${c.downlink || '?'}Mbps, saveData=${!!c.saveData}`
}

let session = null
let textInt8 = null, textScale = null, species = null
let modelReady = false

// ---- background prefetch with progress + speed measurement ----
async function prefetchModel() {
  $('prefetch').disabled = true
  $('net').textContent = netHint()
  const cache = await caches.open('wingdex-bioclip-v1')

  // species + text embeddings first (tiny, needed for inference)
  log('Fetching text-embedding matrix + species list (~9 MB)…')
  const [tBuf, sBuf, spResp] = await Promise.all([
    fetchCached(cache, TEXT_URL), fetchCached(cache, SCALE_URL), fetchCached(cache, SPECIES_URL),
  ])
  textInt8 = new Int8Array(tBuf)
  textScale = new Float32Array(sBuf)
  species = JSON.parse(new TextDecoder().decode(spResp))
  log(`  text matrix ${(tBuf.byteLength/1e6).toFixed(1)} MB, ${species.length} species`)

  // model with streamed progress + speed
  const cached = await cache.match(MODEL_URL)
  if (cached) {
    log('Model already cached — instant load.')
    await initSession(await cached.arrayBuffer())
    return
  }

  log('Streaming model (307 MB int8)… measuring speed.')
  const t0 = performance.now()
  const resp = await fetch(MODEL_URL)
  const total = +resp.headers.get('content-length') || 307e6
  const reader = resp.body.getReader()
  const chunks = []; let recv = 0; let lastLog = t0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value); recv += value.length
    const now = performance.now()
    const kbps = (recv / 1024) / ((now - t0) / 1000)
    $('dlbar').style.width = `${(recv/total*100).toFixed(1)}%`
    if (now - lastLog > 400) {
      const eta = ((total - recv)/1024) / kbps
      $('dlstatus').textContent = `${(recv/1e6).toFixed(0)}/${(total/1e6).toFixed(0)} MB — ${(kbps/1024).toFixed(1)} MB/s — ETA ${eta.toFixed(0)}s`
      lastLog = now
    }
  }
  const blob = new Blob(chunks)
  const buf = await blob.arrayBuffer()
  await cache.put(MODEL_URL, new Response(buf))
  const secs = (performance.now()-t0)/1000
  log(`Model downloaded in ${secs.toFixed(1)}s (${(recv/1024/1024/secs).toFixed(1)} MB/s avg). Cached for next time.`)
  await initSession(buf)
}

async function fetchCached(cache, url) {
  const hit = await cache.match(url)
  if (hit) return await hit.arrayBuffer()
  const resp = await fetch(url)
  const buf = await resp.arrayBuffer()
  await cache.put(url, new Response(buf))
  return buf
}

async function initSession(buf) {
  log('Initializing onnxruntime-web (WebGPU)…')
  try {
    session = await ort.InferenceSession.create(buf, { executionProviders: ['webgpu'] })
    log('  WebGPU session ready.')
  } catch (e) {
    log(`  WebGPU failed (${e.message}); falling back to WASM.`)
    session = await ort.InferenceSession.create(buf, { executionProviders: ['wasm'] })
    log('  WASM session ready.')
  }
  modelReady = true
  $('run').disabled = false
  $('dlstatus').textContent = 'Model ready — on-device ID available.'
}

// ---- preprocessing: 224x224 center, CLIP normalize ----
const MEAN = [0.48145466, 0.4578275, 0.40821073]
const STD = [0.26862954, 0.26130258, 0.27577711]
function preprocess(img) {
  const s = 224
  const c = document.createElement('canvas'); c.width = s; c.height = s
  const ctx = c.getContext('2d')
  const scale = Math.max(s/img.width, s/img.height)
  const w = img.width*scale, h = img.height*scale
  ctx.drawImage(img, (s-w)/2, (s-h)/2, w, h)
  const d = ctx.getImageData(0,0,s,s).data
  const out = new Float32Array(3*s*s)
  for (let i=0;i<s*s;i++){
    out[i]         = ((d[i*4]/255)   - MEAN[0])/STD[0]
    out[i+s*s]     = ((d[i*4+1]/255) - MEAN[1])/STD[1]
    out[i+2*s*s]   = ((d[i*4+2]/255) - MEAN[2])/STD[2]
  }
  return new ort.Tensor('float32', out, [1,3,s,s])
}

// ---- on-device inference: image encoder + int8 text matmul ----
async function bioclipCandidates(img) {
  const t0 = performance.now()
  const input = preprocess(img)
  const out = await session.run({ image: input })
  const emb = out[Object.keys(out)[0]].data // Float32Array(768), already normalized
  // cosine sim vs int8 text matrix (dequant per row)
  const sims = new Float32Array(NUM_SPECIES)
  for (let r=0;r<NUM_SPECIES;r++){
    let dot=0; const base=r*EMBED_DIM; const sc=textScale[r]
    for (let k=0;k<EMBED_DIM;k++) dot += emb[k]*(textInt8[base+k]*sc)
    sims[r]=dot
  }
  // softmax over top region for confidence + candidates
  let mx=-1e9; for (let i=0;i<NUM_SPECIES;i++) if (sims[i]>mx) mx=sims[i]
  let sum=0; const exp=new Float32Array(NUM_SPECIES)
  for (let i=0;i<NUM_SPECIES;i++){ const e=Math.exp((sims[i]-mx)/SOFTMAX_TEMP); exp[i]=e; sum+=e }
  // top-8
  const idx=[...sims.keys()].sort((a,b)=>sims[b]-sims[a]).slice(0,8)
  const cands = idx.map(i=>({ commonName: species[i].c, ebirdCode: species[i].e, confidence: exp[i]/sum }))
  const ms = performance.now()-t0
  return { cands, ms, softmaxTop1: cands[0].confidence }
}

// ---- shared post-processing (simplified: gate only; range would apply here) ----
function postProcess(cands, softmaxTop1) {
  const suggestCrop = softmaxTop1 < CROP_GATE
  // (In production: taxonomy grounding + range-prior tiering + gate go here,
  //  identical for BioCLIP or GPT candidates. Range omitted in this browser demo.)
  return { candidates: cands.slice(0,5), suggestCrop }
}

// ---- GPT fallback (calls the real server endpoint) ----
async function gptFallback() {
  return { server: true, note: 'Would POST to /api/identify-bird (GPT path). Not wired in this static demo.' }
}

// ---- router decision ----
async function identify(img) {
  if (modelReady) {
    $('route').innerHTML = '<span class="pill bioclip">on-device · BioCLIP-2</span>'
    log('Router: model ready → running BioCLIP on-device.')
    const { cands, ms, softmaxTop1 } = await bioclipCandidates(img)
    const pp = postProcess(cands, softmaxTop1)
    renderResult(pp, ms, softmaxTop1, 'BioCLIP-2 (on-device)')
  } else {
    $('route').innerHTML = '<span class="pill gpt">server · GPT fallback</span>'
    log('Router: model not ready → GPT fallback (background prefetch continues).')
    const r = await gptFallback()
    $('result').innerHTML = `<p class="muted">${r.note}</p>`
    if (!$('prefetch').disabled) prefetchModel()
  }
}

function renderResult(pp, ms, softmaxTop1, source) {
  const rows = pp.candidates.map((c,i)=>`<tr><td>${i+1}</td><td>${c.commonName}</td><td>${(c.confidence*100).toFixed(1)}%</td></tr>`).join('')
  $('result').innerHTML = `
    <div class="muted">${source} · ${ms.toFixed(0)} ms · softmax_top1=${softmaxTop1.toFixed(3)}
      ${pp.suggestCrop ? '· <b>⚠ ambiguous — would prompt manual crop</b>' : ''}</div>
    <table><tr><th>#</th><th>species</th><th>conf</th></tr>${rows}</table>`
}

// ---- wire up ----
$('prefetch').addEventListener('click', prefetchModel)
$('net').textContent = netHint()
let currentImg = null
$('file').addEventListener('change', e => {
  const f = e.target.files[0]; if (!f) return
  const url = URL.createObjectURL(f)
  const img = new Image()
  img.onload = () => { currentImg = img; $('thumb').src = url; $('thumb').hidden = false }
  img.src = url
})
$('run').addEventListener('click', () => { if (currentImg) identify(currentImg) })
log('Demo loaded. ' + netHint())
log('Click "Start background prefetch" to download+cache the model, or "Identify" to see GPT fallback first.')
