// Renders a chat to an MP4: frames from engine/index.html (headless Chrome), message tones mixed at the
// timeline's cues (ffmpeg). No Claude here.
//
//   npm run make -- reels/2026-11-14-1300.json      -> out/2026-11-14-1300.mp4 and a contact sheet
//   npm run make -- engine/sample.json --draft      fast, lower quality
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')

// your own recordings in brand/sounds/ win over the lookalike tones in engine/sounds/
function soundFile(name: 'send' | 'receive') {
  const own = ['mp3', 'wav', 'm4a'].map(e => join(ROOT, 'brand/sounds', `${name}.${e}`)).find(existsSync)
  return own ?? join(ROOT, 'engine/sounds', `${name}.wav`)
}

function run(cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 })
  if (r.status !== 0) throw new Error(`${cmd} ${args.slice(0, 2).join(' ')} failed:\n${`${r.stdout}${r.stderr}`.slice(-1500)}`)
  return `${r.stdout}${r.stderr}`
}

export async function make(file: string, opts: { draft?: boolean } = {}): Promise<{ ok: true, mp4: string, duration: number } | { ok: false, errors: string[] }> {
  const name = basename(file, '.json')
  const out = join(ROOT, 'out')
  mkdirSync(out, { recursive: true })
  const silent = join(out, `${name}-silent.mp4`), cuesFile = join(out, `${name}-cues.json`), mp4 = join(out, `${name}.mp4`)
  try {
    console.log('  check')
    const check = run('node', ['scripts/capture.mjs', 'check', file])
    if (!check.includes('CHECK OK')) throw new Error(`engine check failed:\n${check.slice(-1500)}`)
    run('node', ['scripts/capture.mjs', 'cues', file, cuesFile])
    const { duration, cues } = JSON.parse(readFileSync(cuesFile, 'utf8')) as { duration: number, cues: Array<{ t: number, kind: 'in' | 'out' }> }
    console.log(`  frames (${duration.toFixed(1)} s)`)
    run('node', ['scripts/capture.mjs', 'video', file, silent, ...(opts.draft ? ['--draft'] : [])])

    console.log('  sound')
    const send = soundFile('send'), receive = soundFile('receive')
    const inputs = cues.flatMap(c => ['-i', c.kind === 'out' ? send : receive])
    const delays = cues.map((c, i) => `[${i + 1}:a]aresample=48000,adelay=${Math.round(c.t * 1000)}:all=1[a${i}]`)
    const mix = cues.length
      ? `${delays.join(';')};${cues.map((_, i) => `[a${i}]`).join('')}amix=inputs=${cues.length}:normalize=0,volume=0.9,apad[aud]`
      : 'anullsrc=r=48000:cl=stereo[aud]'
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', silent, ...inputs, '-filter_complex', mix, '-map', '0:v', '-map', '[aud]',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-t', duration.toFixed(3), '-movflags', '+faststart', mp4])
    run('node', ['scripts/capture.mjs', 'sheet', file, join(out, `${name}-sheet.jpg`), '1', '8'])
    rmSync(silent, { force: true })

    const got = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mp4]).toString().trim())
    const audio = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', mp4]).toString().trim()
    const errors: string[] = []
    if (got < 7 || got > 30) errors.push(`video is ${got.toFixed(1)}s; expected 7-30s`)
    if (!audio) errors.push('video has no audio track')
    return errors.length ? { ok: false, errors } : { ok: true, mp4, duration: got }
  }
  catch (e) {
    return { ok: false, errors: [(e as Error).message] }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv.slice(2).find(a => !a.startsWith('--'))
  if (!file) { console.error('Usage: npm run make -- reels/<id>.json [--draft]'); process.exit(1) }
  const r = await make(file, { draft: process.argv.includes('--draft') })
  if (!r.ok) { console.error(`✗ ${r.errors.join('\n  ')}`); process.exit(1) }
  console.log(`✓ ${r.mp4} (${r.duration.toFixed(1)}s)`)
}
