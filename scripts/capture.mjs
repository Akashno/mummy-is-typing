// Drives engine/index.html in headless Chrome and screenshots it frame by frame. No npm packages (Node 22+).
//
//   node scripts/capture.mjs preview [reels/x.json]            serve the repo and print a URL to watch it live
//   node scripts/capture.mjs check  reels/x.json                boot, print duration and cues, render every 0.25 s
//   node scripts/capture.mjs cues   reels/x.json out/cues.json  write the sound cues and duration
//   node scripts/capture.mjs sheet  reels/x.json out/x-sheet.jpg [step=1] [cols=8]   contact sheet
//   node scripts/capture.mjs video  reels/x.json out/x-silent.mp4 [--draft]          the film, 30 fps, no audio
//
// CHROME=/path/to/chrome overrides the browser.
import { spawn, spawnSync } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FPS = +(process.env.FPS || 30)
const W = 1080, H = 1920
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const args = process.argv.slice(2), flags = new Set(args.filter((a) => a.startsWith('--')))
const [mode, chatFile, ...rest] = args.filter((a) => !a.startsWith('--'))

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wav': 'audio/wav', '.mp3': 'audio/mpeg' }
function serve(port = 0) {
  return new Promise((res) => {
    const srv = http.createServer((req, r) => {
      const u = decodeURIComponent(req.url.split('?')[0]), f = path.join(ROOT, u === '/' ? 'engine/index.html' : u)
      if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); r.end(); return }
      r.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' })
      fs.createReadStream(f).pipe(r)
    })
    srv.listen(port, '127.0.0.1', () => res(srv))
  })
}

// Any Chrome will do; with none installed, fetch the small headless build once (shared with untold-files).
function chromePath() {
  const known = [process.env.CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((x) => x && fs.existsSync(x))
  if (known) return known
  const dir = path.join(os.homedir(), '.cache/untold-chrome')
  const find = (d = dir) => {
    if (!fs.existsSync(d)) return
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isFile() && e.name === 'chrome-headless-shell') return p
      if (e.isDirectory()) { const r = find(p); if (r) return r }
    }
  }
  if (!find()) {
    console.log('  no Chrome found; downloading chrome-headless-shell once')
    spawnSync('npx', ['-y', '@puppeteer/browsers@2.10.5', 'install', 'chrome-headless-shell@stable', '--path', dir], { stdio: 'inherit' })
  }
  const p = find()
  if (!p) throw new Error('could not find or install Chrome; set CHROME=/path/to/chrome')
  return p
}

async function openPage(url) {
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'mit-chrome-'))
  const chrome = spawn(chromePath(), ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${prof}`, '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', `--window-size=${W},${H}`, '--font-render-hinting=none', ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []),
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank'], { stdio: 'ignore' })
  let dbg
  for (let i = 0; i < 200 && !dbg; i++) { try { dbg = fs.readFileSync(path.join(prof, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim() } catch { await sleep(100) } }
  if (!dbg) throw new Error('Chrome did not start')
  const target = await (await fetch(`http://127.0.0.1:${dbg}/json/new?about:blank`, { method: 'PUT' })).json()
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let id = 0; const pend = new Map(), logs = []
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result) }
    else if (m.method === 'Runtime.exceptionThrown') logs.push('EXCEPTION ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text))
    else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') logs.push('ERROR ' + m.params.args.map((a) => a.value ?? a.description).join(' '))
  }
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })) })
  const ev = async (expr) => {
    const x = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (x.exceptionDetails) throw new Error(x.exceptionDetails.exception?.description || x.exceptionDetails.text)
    return x.result.value
  }
  await send('Runtime.enable'); await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url })
  for (let i = 0; ; i++) {
    const s = await ev('window.OP ? (OP.bootError ? "ERR:" + OP.bootError : OP.ready) : false').catch(() => false)
    if (s === true) break
    if (typeof s === 'string') throw new Error('boot failed: ' + s + '\n' + logs.join('\n'))
    if (i > 600) throw new Error('boot timeout\n' + logs.join('\n'))
    await sleep(100)
  }
  const shot = async (t, quality = 92) => {
    await ev(`OP.render(${t})`)
    const r = await send('Page.captureScreenshot', { format: 'jpeg', quality, clip: { x: 0, y: 0, width: W, height: H, scale: 1 } })
    return Buffer.from(r.data, 'base64')
  }
  const close = () => { try { ws.close() } catch {} chrome.kill('SIGKILL'); setTimeout(() => { try { fs.rmSync(prof, { recursive: true, force: true }) } catch {} }, 300) }
  return { ev, shot, logs, close }
}

const srv = await serve(mode === 'preview' ? 8766 : 0), port = srv.address().port
const rel = chatFile ? path.relative(ROOT, path.resolve(chatFile)) : 'engine/sample.json'
const pageUrl = `http://127.0.0.1:${port}/engine/index.html?chat=${encodeURIComponent(rel.startsWith('engine/') ? rel.slice(7) : rel)}`
if (mode === 'preview') console.log(`open ${pageUrl}  (Ctrl+C to stop)`)
else {
  if (!chatFile) { console.error('usage: node scripts/capture.mjs <check|cues|sheet|video|preview> <chat.json> [out]'); process.exit(1) }
  const P = await openPage(pageUrl + '&capture=1')
  try {
    const dur = await P.ev('OP.duration()')
    if (mode === 'check') {
      console.log(`duration ${dur.toFixed(2)} s`)
      for (const c of await P.ev('OP.cues()')) console.log(`  ${c.t.toFixed(2).padStart(6)} ${c.kind}`)
      let bad = 0
      for (let t = 0; t < dur; t += 0.25) { try { await P.ev(`OP.render(${t})`) } catch (e) { bad++; console.log(`ERROR at ${t.toFixed(2)}: ${e.message.split('\n')[0]}`) } }
      if (P.logs.length) console.log(P.logs.join('\n'))
      console.log(bad || P.logs.length ? 'CHECK FAILED' : 'CHECK OK')
    }
    else if (mode === 'cues') {
      const out = path.resolve(rest[0] || 'out/cues.json'); fs.mkdirSync(path.dirname(out), { recursive: true })
      fs.writeFileSync(out, JSON.stringify({ duration: dur, cues: await P.ev('OP.cues()') }, null, 1))
      console.log(out)
    }
    else if (mode === 'sheet') {
      const out = path.resolve(rest[0] || 'out/sheet.jpg'), step = +(rest[1] || 1), cols = +(rest[2] || 8)
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mit-sheet-')); let n = 0; fs.mkdirSync(path.dirname(out), { recursive: true })
      for (let t = 0; t < dur; t += step) fs.writeFileSync(path.join(tmp, `f${String(n++).padStart(4, '0')}.jpg`), await P.shot(t, 80))
      const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-framerate', '1', '-i', path.join(tmp, 'f%04d.jpg'), '-vf', `scale=270:480,tile=${cols}x${Math.ceil(n / cols)}:padding=4:color=black`, '-frames:v', '1', '-q:v', '3', out])
      fs.rmSync(tmp, { recursive: true, force: true })
      if (r.status) throw new Error('ffmpeg: ' + r.stderr)
      console.log(`${out} (${n} frames, every ${step} s)`)
    }
    else if (mode === 'video') {
      const out = path.resolve(rest[0] || 'out/video.mp4'); fs.mkdirSync(path.dirname(out), { recursive: true })
      const n = Math.round(dur * FPS), draft = flags.has('--draft')
      const ff = spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-', '-c:v', 'libx264', '-preset', draft ? 'ultrafast' : 'veryfast',
        '-crf', draft ? '28' : '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] })
      const t0 = Date.now()
      for (let i = 0; i < n; i++) {
        const b = await P.shot(i / FPS, draft ? 80 : 93)
        if (!ff.stdin.write(b)) await new Promise((r) => ff.stdin.once('drain', r))
        if (i % 60 === 0) process.stdout.write(`\r  ${i}/${n} frames`)
      }
      ff.stdin.end(); await new Promise((r) => ff.on('close', r))
      console.log(`\r  ${out} (${n} frames, ${((Date.now() - t0) / 1000).toFixed(0)} s)`)
    }
    else console.log('modes: preview · check · cues · sheet · video')
  }
  finally { P.close(); srv.close() }
}
