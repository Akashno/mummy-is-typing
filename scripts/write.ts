// Writes the next reel with ONE headless Claude Code call (your Claude subscription, no API key).
//
//   npm run write                              -> reels/<next slot>.json
//   npm run write -- --id 2026-11-14-1300      a given slot
//   npm run write -- --series papa-replies     force a series
//   npm run check -- reels/<id>.json           run the checks on a reel you edited by hand
//
// Claude gets the brief, today's series and every past premise, and returns five candidate chats ranked
// funniest first. The best one that passes the checks is kept; only if none passes is Claude asked once more,
// with the exact problems.
import { nextSlot } from './slot.mjs'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import Ajv from 'ajv'
import { BRAND, CAST, SERIES, type Series } from '../src/brand'
import type { Chat, Reel } from '../src/types'
import { timeline } from '../engine/timeline.js'

const ROOT = resolve(import.meta.dirname, '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const MODEL = process.env.CLAUDE_MODEL ?? 'sonnet'
const TRIES = 2

export interface HistoryEntry { date: string, title: string, series: string, premise: string, status: 'test' | 'rendered' | 'posted' | 'failed' }
export const HISTORY = join(ROOT, 'data/history.json')
export const loadHistory = (): HistoryEntry[] => (existsSync(HISTORY) ? JSON.parse(readFileSync(HISTORY, 'utf8')) : [])

// ---- checks ---------------------------------------------------------------------------------------
const SCHEMA = JSON.parse(read('chat.schema.json'))
const validateChat = new Ajv({ allErrors: true, strict: false }).addSchema(SCHEMA, 'c').compile({ $ref: 'c#/definitions/chat' })

const EMOJI = /\p{Extended_Pictographic}/gu
const BANNED: Array<[RegExp, string]> = [
  [/wait for it/i, '"wait for it"'], [/\bpov\b/i, '"POV"'], [/plot twist/i, '"plot twist"'], [/#/, 'a hashtag inside the chat'],
  [/sharma ?ji/i, 'Sharma ji'], [/chappal/i, 'chappal'], [/log kya kahenge/i, '"log kya kahenge"'], [/tum nahi samjhoge/i, '"tum nahi samjhoge"'],
  [/—/, 'an em dash'], [/[😂🤣]/u, '😂/🤣 inside the chat (we never laugh at our own jokes)'],
]

export function checkChat(x: unknown, series?: Series): string[] {
  if (!validateChat(x))
    return (validateChat.errors ?? []).slice(0, 10).map(e => `${e.instancePath || '/'} ${e.message}`)
  const c = x as Chat
  const errors: string[] = []
  const msgs = c.script.filter(l => l.who !== 'react')
  const reacts = c.script.filter(l => l.who === 'react')
  if (msgs.length < 4 || msgs.length > 10) errors.push(`${msgs.length} messages; write 5-9`)
  if (c.script[0].who !== 'them') errors.push('the first message must be from them (it is the hook, on screen at frame 0)')
  if (c.script.at(-1)!.who === 'react') errors.push('end on the punchline message, not a reaction')
  if (!msgs.some(l => l.who === 'me')) errors.push('"me" never speaks')
  if (reacts.length > 1) errors.push('at most one reaction per chat')
  for (const r of reacts) if ([...r.text.matchAll(EMOJI)].length !== 1) errors.push(`a reaction must be exactly one emoji, not "${r.text}"`)
  const nani = c.cast === 'nani'
  let emoji = 0
  msgs.forEach((l, i) => {
    const n = [...l.text.matchAll(EMOJI)].length
    emoji += n
    if (n > (nani && l.who === 'them' ? 3 : 1)) errors.push(`message ${i + 1} ("${l.text}") has ${n} emoji; at most one, only where it shows a feeling`)
    if ([...l.text].length > 90) errors.push(`message ${i + 1} is too long; keep messages under 60 characters`)
    for (const [re, what] of BANNED) if (re.test(l.text)) errors.push(`message ${i + 1}: ${what} is not allowed`)
  })
  if (emoji > (nani ? 5 : 3)) errors.push(`${emoji} emoji in the chat; use ${nani ? 5 : 3} at most, only where they show a feeling`)
  const dur = timeline({ title: c.title, script: c.script }).duration
  if (dur < 8 || dur > 24) errors.push(`the chat plays for ${dur.toFixed(1)}s; aim for 10-20s`)
  if (series && series.contact !== 'any' && series.contact !== c.cast) errors.push(`series "${series.id}" is a chat with ${series.contact}, not ${c.cast}`)
  if (/#/.test(c.post.caption)) errors.push('no hashtags in post.caption; they go in post.hashtags')
  if (!c.post.hashtags.some(h => h.toLowerCase() === BRAND.hashtag)) errors.push(`hashtags must include ${BRAND.hashtag}`)
  return errors
}

// ---- novelty ----------------------------------------------------------------------------------------
const STOP = new Set('a an the and or but of to in on at for with your you her his their that this from by is was it me my mummy papa nani didi asks says'.split(' '))
const bag = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !STOP.has(w)))
function similar(a: string, b: string) {
  const A = bag(a), B = bag(b)
  if (!A.size || !B.size) return 0
  let n = 0
  for (const w of A) if (B.has(w)) n++
  return n / (A.size + B.size - n)
}
const noveltyErrors = (c: Chat, history: HistoryEntry[]) => history
  .filter(h => similar(c.premise, h.premise) > 0.4)
  .map(h => `too close to a past reel, "${h.title}" (${h.date}): pick a different situation`)

// ---- series rotation: each series gets its weight's share of the last 30 reels ------------------------
export function pickSeries(history: HistoryEntry[]) {
  const recent = history.filter(h => h.status !== 'test' && h.status !== 'failed').slice(-30)
  const total = SERIES.reduce((n, s) => n + s.weight, 0)
  const last = (id: string) => recent.filter(h => h.series === id).map(h => h.date).at(-1) ?? ''
  const need = (s: Series) => (s.weight / total) * (recent.length + 1) - recent.filter(h => h.series === s.id).length
  return [...SERIES].sort((a, b) => need(b) - need(a) || last(a.id).localeCompare(last(b.id)))[0]
}

// ---- prompt -----------------------------------------------------------------------------------------
function system() {
  const cast = CAST.map(p => `- **${p.id}** (saved in your phone as "${p.contact}"): ${p.who} Texts: ${p.texts}`).join('\n')
  const vars: Record<string, string> = { name: BRAND.name, handle: BRAND.handle, pitch: BRAND.pitch, audience: BRAND.audience, cast }
  return read('prompts/writer.md').replace(/\{\{(\w+)\}\}/g, (all, k: string) => vars[k] ?? all)
}
function buildPrompt(date: string, s: Series, history: HistoryEntry[]) {
  return [
    `# Today\n\nReel ${date}. Series: **${s.id}**: ${s.brief}${s.contact === 'any' ? '' : `\nEvery candidate is a chat with ${s.contact}.`}`,
    `Hashtags: always ${BRAND.hashtag}, plus 2-4 broad ones (e.g. #indianfamily #desimom #relatable #whatsappchat).`,
    '# Past reels (never repeat these situations)',
    history.length ? history.slice(-300).reverse().map(h => `- ${h.title}: ${h.premise}`).join('\n') : '(none yet: this is the first one)',
  ].join('\n\n')
}

function askClaude(prompt: string): { out?: { candidates: Chat[], ranking: number[] }, error?: string, tokens?: string } {
  const r = spawnSync('claude', ['-p', '--model', MODEL, '--tools', '', '--no-session-persistence', '--strict-mcp-config', '--disable-slash-commands',
    '--output-format', 'json', '--json-schema', JSON.stringify(SCHEMA), '--system-prompt', system()],
  { input: prompt, encoding: 'utf8', cwd: ROOT, timeout: 300_000, maxBuffer: 20 * 1024 * 1024 })
  if (r.error) return { error: `could not run claude: ${r.error.message}` }
  let out: any
  try { out = JSON.parse(r.stdout) }
  catch { return { error: `claude exited ${r.status}: ${(r.stderr || r.stdout).slice(0, 400)}` } }
  if (out.is_error || !out.structured_output)
    return { error: `claude returned nothing usable (${out.subtype ?? 'error'}): ${String(out.result ?? '').slice(0, 300)}` }
  const u = out.usage ?? {}
  const n = (k: string) => u[k] ?? 0
  return { out: out.structured_output, tokens: `${n('input_tokens') + n('cache_creation_input_tokens') + n('cache_read_input_tokens') + n('output_tokens')} tokens, ${Math.round((out.duration_ms ?? 0) / 1000)}s` }
}

export function toReel(c: Chat, series: string): Reel {
  const h = Number(c.clock.slice(0, 2))
  return {
    ...c,
    series,
    contact: CAST.find(p => p.id === c.cast)!.contact,
    theme: h >= 22 || h < 6 ? 'dark' : 'light', // late-night chats in dark mode, like a real phone
    showCaption: false,
  }
}

export async function write(date: string, opts: { series?: string } = {}): Promise<{ ok: true, file: string, reel: Reel } | { ok: false, errors: string[] }> {
  const history = loadHistory().filter(h => h.date < date)
  const s = SERIES.find(x => x.id === opts.series) ?? pickSeries(history)
  const base = buildPrompt(date, s, history)
  console.log(`Writing ${date}: series "${s.id}" (${MODEL})`)
  let prompt = base
  let errors: string[] = []
  for (let attempt = 1; attempt <= TRIES; attempt++) {
    const res = askClaude(prompt)
    if (!res.out) {
      errors = [res.error!]
      console.log(`  attempt ${attempt}: ${res.error}`)
      if (/authenticat|401|invalid api key|oauth/i.test(res.error!)) break
      continue
    }
    const { candidates, ranking } = res.out
    const order = [...new Set([...ranking.filter(i => i < candidates.length), ...candidates.keys()])]
    console.log(`  attempt ${attempt}: ${candidates.length} candidates (${res.tokens})`)
    const rejected: string[] = []
    for (const i of order) {
      const c = candidates[i]
      const errs = [...checkChat(c, s), ...noveltyErrors(c, history)]
      console.log(`    #${i} "${c.title}"${errs.length ? `: rejected (${errs.join('; ')})` : ': kept'}`)
      if (!errs.length) {
        const reel = toReel(c, s.id)
        mkdirSync(join(ROOT, 'reels'), { recursive: true })
        const file = join(ROOT, 'reels', `${date}.json`)
        writeFileSync(file, `${JSON.stringify(reel, null, 2)}\n`)
        return { ok: true, file, reel }
      }
      rejected.push(`"${c.title}": ${errs.join('; ')}`)
    }
    errors = rejected
    prompt = `${base}\n\n# Every candidate in your previous attempt was rejected\n\n${rejected.map(e => `- ${e}`).join('\n')}\n\nWrite five new candidates that fix these problems.`
  }
  return { ok: false, errors }
}

export function record(date: string, r: Reel, status: HistoryEntry['status']) {
  const history = loadHistory().filter(h => h.date !== date)
  history.push({ date, title: r.title, series: r.series, premise: r.premise, status })
  history.sort((a, b) => a.date.localeCompare(b.date))
  mkdirSync(join(ROOT, 'data'), { recursive: true })
  writeFileSync(HISTORY, `${JSON.stringify(history, null, 2)}\n`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (n: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined }
  if (process.argv.includes('--check')) {
    const r: Reel = JSON.parse(readFileSync(process.argv.at(-1)!, 'utf8'))
    const errors = checkChat({ title: r.title, premise: r.premise, cast: r.cast, clock: r.clock, script: r.script, caption: r.caption, post: r.post }, SERIES.find(s => s.id === r.series))
    console.log(errors.length ? `✗ ${errors.join('\n  ')}` : '✓ passes the checks')
    process.exit(errors.length ? 1 : 0)
  }
  const r = await write(arg('--id') ?? nextSlot({ any: true }), { series: arg('--series') })
  if (!r.ok) { console.error(`✗ no usable chat:\n  ${r.errors.join('\n  ')}`); process.exit(1) }
  console.log(`✓ ${r.file}`)
}
