// Writes the next reel with ONE headless Claude Code call (your Claude subscription, no API key).
//
//   npm run write                              -> reels/<next slot>.json
//   npm run write -- --id 2026-11-14-1300      a given slot
//   npm run write -- --series papa-replies     force a series
//   npm run check -- reels/<id>.json           run the checks on a reel you edited by hand
//
// Claude gets the brief, today's series, the unused real moments in ideas.md and every past premise, and returns
// five candidate chats ranked. The ones that pass the checks go to a second, harsh Claude call (prompts/judge.md)
// that scores each for realness and funniness and lists its AI tells. The best one the judge passes is kept; if
// none passes, the writer is asked again with the exact problems.
import { nextSlot } from './slot.mjs'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import Ajv from 'ajv'
import { BRAND, CAST, SERIES, type Series } from '../src/brand'
import type { Chat, Line, Reel, Score } from '../src/types'
import { timeline } from '../engine/timeline.js'

const ROOT = resolve(import.meta.dirname, '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const MODEL = process.env.CLAUDE_MODEL ?? 'sonnet'
const JUDGE_MODEL = process.env.JUDGE_MODEL ?? MODEL
const TRIES = 3

export interface HistoryEntry { date: string, title: string, series: string, premise: string, art?: string, status: 'test' | 'rendered' | 'posted' | 'failed' }
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

// models like to write *word* (markdown); the cover wants *word
const markWord = (h: string) => h.replace(/\*([^*\s]+)\*/g, '*$1')

export function checkChat(x: unknown, series?: Series): string[] {
  if (!validateChat(x))
    return (validateChat.errors ?? []).slice(0, 10).map(e => `${e.instancePath || '/'} ${e.message}`)
  const c = x as Chat
  const errors: string[] = []
  const msgs = c.script.filter(l => l.who === 'them' || l.who === 'me')
  const texts = msgs.filter(l => (l.kind ?? 'text') === 'text' || l.kind === 'deleted')
  let clock = c.clock
  c.script.forEach((l, i) => {
    const k = l.kind ?? 'text'
    if (l.who === 'time') {
      if (!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(l.text)) errors.push(`item ${i + 1}: a time jump needs HH:MM, not "${l.text}"`)
      else if (l.text <= clock && !(clock >= '20:00' && l.text < '06:00')) errors.push(`item ${i + 1}: the clock goes back from ${clock} to ${l.text}`)
      clock = l.text
    }
    if (l.who === 'time' || l.who === 'react') { if (l.kind || l.forwarded) errors.push(`item ${i + 1}: kind/forwarded only go on messages`) ; return }
    if (k === 'voice' && !/^\d{1,2}:[0-5]\d$/.test(l.text)) errors.push(`item ${i + 1}: a voice note's text is its length like "0:14", not "${l.text}"`)
    if (k === 'missed-call' && l.who !== 'them') errors.push(`item ${i + 1}: only Mummy's calls show as missed`)
    if (l.forwarded && (l.who !== 'them' || k !== 'text')) errors.push(`item ${i + 1}: only Mummy's text messages are forwarded`)
  })
  const fancy = msgs.filter(l => (l.kind ?? 'text') !== 'text' || l.forwarded).length
  if (fancy > 3) errors.push(`${fancy} voice notes / calls / deletes / forwards; use them only where they are the joke or the realism (at most 3)`)
  if (c.script.at(-1)!.who === 'time') errors.push('the chat cannot end on a time jump')
  const reacts = c.script.filter(l => l.who === 'react')
  if (msgs.length < 4 || msgs.length > 10) errors.push(`${msgs.length} messages; write 5-9`)
  if (c.script[0].who !== 'them') errors.push('the first item must be from Mummy (a message or a missed call): it is the hook, on screen at frame 0')
  if (c.script.at(-1)!.who === 'react') errors.push('end on the punchline message, not a reaction')
  if (!msgs.some(l => l.who === 'me')) errors.push('"me" never speaks')
  if (reacts.length > 1) errors.push('at most one reaction per chat')
  for (const r of reacts) if ([...r.text.matchAll(EMOJI)].length !== 1) errors.push(`a reaction must be exactly one emoji, not "${r.text}"`)
  let emoji = 0
  texts.forEach((l, i) => {
    const n = [...l.text.matchAll(EMOJI)].length
    emoji += n
    if (n > 1) errors.push(`message ${i + 1} ("${l.text}") has ${n} emoji; at most one, only where it shows a feeling`)
    if ([...l.text].length > 90) errors.push(`message ${i + 1} is too long; keep messages under 60 characters`)
    for (const [re, what] of BANNED) if (re.test(l.text)) errors.push(`message ${i + 1}: ${what} is not allowed`)
  })
  if (emoji > 3) errors.push(`${emoji} emoji in the chat; use 3 at most, only where they show a feeling`)
  const dur = timeline({ title: c.title, script: c.script, clock: c.clock }, { cover: false }).duration
  if (dur < 8 || dur > 24) errors.push(`the chat plays for ${dur.toFixed(1)}s; aim for 10-20s`)
  c.cover.headline = markWord(c.cover.headline)
  const stars = (c.cover.headline.match(/\*/g) ?? []).length
  if (stars !== 1) errors.push(`cover.headline needs exactly one *word for the green marker, not ${stars}`)
  const hw = c.cover.headline.split(/\s+/).filter(Boolean).length
  if (hw < 3 || hw > 8) errors.push(`cover.headline is ${hw} words; use 3-7`)
  if ([...c.cover.emoji.matchAll(EMOJI)].length !== 1) errors.push(`cover.emoji must be exactly one emoji, not "${c.cover.emoji}"`)
  if ([...c.cover.headline.matchAll(EMOJI)].length) errors.push('no emoji inside cover.headline; it goes in cover.emoji')
  if (/send (this|it) to|tag (your|a)|relatable|when your m(o|u)m/i.test(c.post.caption)) errors.push('post.caption: no calls to action or "when your mom", just react')
  if (/#/.test(c.post.caption)) errors.push('no hashtags in post.caption; they go in post.hashtags')
  if (!c.post.hashtags.some(h => h.toLowerCase() === BRAND.hashtag)) errors.push(`hashtags must include ${BRAND.hashtag}`)
  return errors
}

// ---- novelty ----------------------------------------------------------------------------------------
const STOP = new Set('a an the and or but of to in on at for with your you her his their that this from by is was it me my mummy daughter beta asks says'.split(' '))
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

// ---- ideas.md: real moments, used before anything invented ---------------------------------------------
const IDEAS = join(ROOT, 'ideas.md')
export function openIdeas(): string[] {
  if (!existsSync(IDEAS)) return []
  return readFileSync(IDEAS, 'utf8').split('\n').filter(l => l.startsWith('- [ ] ')).map(l => l.slice(6).trim())
}
function useIdea(idea: string, date: string) {
  const s = readFileSync(IDEAS, 'utf8')
  writeFileSync(IDEAS, s.replace(`- [ ] ${idea}`, `- [x] ${idea} (${date})`))
}

// ---- prompt -----------------------------------------------------------------------------------------
function system() {
  const cast = CAST.map(p => `- **${p.id}** (saved in your phone as "${p.contact}"): ${p.who} Texts: ${p.texts}`).join('\n')
  const vars: Record<string, string> = { name: BRAND.name, handle: BRAND.handle, pitch: BRAND.pitch, audience: BRAND.audience, cast }
  return read('prompts/writer.md').replace(/\{\{(\w+)\}\}/g, (all, k: string) => vars[k] ?? all)
}
function buildPrompt(date: string, s: Series, history: HistoryEntry[], ideas: string[]) {
  return [
    `# Today\n\nReel ${date}. Series: **${s.id}**: ${s.brief}`,
    ideas.length
      ? `# Real moments (use these first)\n\nThese happened to real people. Build at least two candidates on them, keeping what actually happened and adding nothing clever; set \`idea\` to the number. They may bend the series.\n\n${ideas.map((x, i) => `${i}. ${x}`).join('\n')}`
      : '',
    `Hashtags: always ${BRAND.hashtag}, plus 2-4 broad ones (e.g. #desimom #indianmom #motherdaughter #relatable).`,
    '# Past reels (never repeat these situations)',
    history.length ? history.slice(-300).reverse().map(h => `- ${h.title}: ${h.premise}`).join('\n') : '(none yet: this is the first one)',
  ].filter(Boolean).join('\n\n')
}

// what the judge reads: the chat as a plain transcript, the way a viewer experiences it
function transcript(c: Chat) {
  const line = (l: Line) => {
    const who = l.who === 'them' ? 'Mummy' : 'Me'
    const p = l.pause ? `(pause ${l.pause}s) ` : ''
    if (l.who === 'time') return `--- ${l.text} ---`
    if (l.who === 'react') return `${p}[reacts ${l.text}]`
    if (l.kind === 'missed-call') return `${p}${who}: [missed voice call]`
    if (l.kind === 'voice') return `${p}${who}: [voice note ${l.text}]`
    if (l.kind === 'deleted') return `${p}${who}: ${l.who === 'me' ? `[sent then deleted: ${l.text}]` : '[deleted, never read]'}`
    return `${p}${who}: ${l.forwarded ? '[forwarded] ' : ''}${l.text}`
  }
  return [`Phone clock ${c.clock}`, ...c.script.map(line), `Post caption: ${c.post.caption}`].join('\n')
}
const JUDGE_SCHEMA = JSON.parse(read('judge.schema.json'))
function judgeSystem() {
  const vars: Record<string, string> = { name: BRAND.name, pitch: BRAND.pitch, audience: BRAND.audience }
  return read('prompts/judge.md').replace(/\{\{(\w+)\}\}/g, (all, k: string) => vars[k] ?? all)
}
function judge(chats: Chat[]) {
  const prompt = chats.map((c, n) => `## Chat ${n}\n\n${transcript(c)}`).join('\n\n')
  return askClaude<{ scores: Score[] }>(prompt, { model: JUDGE_MODEL, schema: JUDGE_SCHEMA, system: judgeSystem() })
}
const rank = (x: Score) => x.real * 2 + x.funny // realness counts double

function askClaude<T = { candidates: Chat[], ranking: number[] }>(prompt: string, o: { model?: string, schema?: object, system?: string } = {}): { out?: T, error?: string, tokens?: string } {
  const r = spawnSync('claude', ['-p', '--model', o.model ?? MODEL, '--tools', '', '--no-session-persistence', '--strict-mcp-config', '--disable-slash-commands',
    '--output-format', 'json', '--json-schema', JSON.stringify(o.schema ?? SCHEMA), '--system-prompt', o.system ?? system()],
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

// the cover illustration used longest ago (brand/art.json), so the grid never shows the same picture twice in a row
export function pickArt(history: HistoryEntry[]) {
  const art: Array<{ id: string }> = JSON.parse(read('brand/art.json'))
  const last = (id: string) => history.filter(h => h.art === id).map(h => h.date).at(-1) ?? ''
  return [...art].sort((a, b) => last(a.id).localeCompare(last(b.id)))[0].id
}

export function toReel(c: Chat, series: string, art: string): Reel {
  const h = Number(c.clock.slice(0, 2))
  return {
    ...c,
    series,
    art,
    contact: CAST.find(p => p.id === c.cast)!.contact,
    theme: h >= 22 || h < 6 ? 'dark' : 'light', // late-night chats in dark mode, like a real phone
    showCaption: false,
  }
}

export async function write(date: string, opts: { series?: string } = {}): Promise<{ ok: true, file: string, reel: Reel } | { ok: false, errors: string[] }> {
  const history = loadHistory().filter(h => h.date < date)
  const s = SERIES.find(x => x.id === opts.series) ?? pickSeries(history)
  const ideas = openIdeas().slice(0, 8)
  const base = buildPrompt(date, s, history, ideas)
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
    const passed: Chat[] = []
    for (const i of order) {
      const c = candidates[i]
      const errs = [...checkChat(c, s), ...noveltyErrors(c, history)]
      console.log(`    #${i} "${c.title}"${errs.length ? `: rejected (${errs.join('; ')})` : ': passes the checks'}`)
      if (errs.length) rejected.push(`"${c.title}": ${errs.join('; ')}`)
      else passed.push(c)
    }
    if (passed.length) {
      const j = judge(passed)
      if (!j.out) { console.log(`  judge: ${j.error}`); rejected.push(`(the judge could not run: ${j.error})`) }
      else {
        console.log(`  judge (${j.tokens})`)
        const scored = j.out.scores.filter(x => passed[x.n])
        for (const x of scored)
          console.log(`    "${passed[x.n].title}": real ${x.real}, funny ${x.funny}, ${x.verdict}${x.tells.length ? `; tells: ${x.tells.join(' | ')}` : ''}`)
        const best = scored.filter(x => x.verdict === 'pass' && x.real >= 7 && x.funny >= 6).sort((a, b) => rank(b) - rank(a))[0]
        if (best) {
          const c = passed[best.n]
          const reel: Reel = { ...toReel(c, s.id, pickArt(history)), judge: best }
          mkdirSync(join(ROOT, 'reels'), { recursive: true })
          const file = join(ROOT, 'reels', `${date}.json`)
          writeFileSync(file, `${JSON.stringify(reel, null, 2)}\n`)
          if (c.idea != null && ideas[c.idea]) useIdea(ideas[c.idea], date)
          console.log(`  kept "${c.title}"`)
          return { ok: true, file, reel }
        }
        for (const x of scored)
          rejected.push(`"${passed[x.n].title}": the judge failed it (real ${x.real}/10, funny ${x.funny}/10). AI tells: ${x.tells.join('; ') || 'none'}. ${x.fix}`)
      }
    }
    errors = rejected
    prompt = `${base}\n\n# Every candidate in your previous attempt was rejected\n\n${rejected.map(e => `- ${e}`).join('\n')}\n\nWrite five new candidates that fix these problems. Do not patch the failed ones; start from what really happens in a chat like this.`
  }
  return { ok: false, errors }
}

export function record(date: string, r: Reel, status: HistoryEntry['status']) {
  const history = loadHistory().filter(h => h.date !== date)
  history.push({ date, title: r.title, series: r.series, premise: r.premise, art: r.art, status })
  history.sort((a, b) => a.date.localeCompare(b.date))
  mkdirSync(join(ROOT, 'data'), { recursive: true })
  writeFileSync(HISTORY, `${JSON.stringify(history, null, 2)}\n`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (n: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined }
  if (process.argv.includes('--check')) {
    const r: Reel = JSON.parse(readFileSync(process.argv.at(-1)!, 'utf8'))
    const errors = checkChat({ title: r.title, premise: r.premise, cast: r.cast, clock: r.clock, script: r.script, caption: r.caption, cover: r.cover, post: r.post }, SERIES.find(s => s.id === r.series))
    console.log(errors.length ? `✗ ${errors.join('\n  ')}` : '✓ passes the checks')
    process.exit(errors.length ? 1 : 0)
  }
  const r = await write(arg('--id') ?? nextSlot({ any: true }), { series: arg('--series') })
  if (!r.ok) { console.error(`✗ no usable chat:\n  ${r.errors.join('\n  ')}`); process.exit(1) }
  console.log(`✓ ${r.file}`)
}
