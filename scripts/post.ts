// Schedules the day's video on every channel through Buffer.
//
//   npm run post -- <id>                           schedule video <id> (e.g. 2026-11-10-1900) at its slot time
//   npm run post -- <date> --dry                   print what would be sent
//   npm run post -- <date> --only instagram        one channel
//   npm run post -- <date> --at 2026-12-20T13:30:00Z --url https://...mp4
//   npm run post -- <date> --now                   post in about 5 minutes instead of at its slot time
//   npm run post -- --channels                     list the Buffer channels for every BUFFER_API_KEY_*
//   npm run post -- <date> --status                show each saved post's status
//   npm run post -- <date> --delete                delete the saved posts (tests)
//   npm run post -- --backfill youtube [--gap 30] [--dry]
//                                                  send every video already posted elsewhere to a newly added
//                                                  channel, oldest first, one every --gap minutes from now
//
// Needs BUFFER_API_KEY_1 / BUFFER_API_KEY_2 (environment or .env). What was scheduled is saved
// in data/posts/<date>.json, so a re-run never posts a channel twice.
import { postTime } from './slot.mjs'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { BRAND } from '../src/brand'
import type { Reel } from '../src/types'
import { timeline } from '../engine/timeline.js'

const ROOT = resolve(import.meta.dirname, '..')
// Where GitHub Pages serves the videos. PAGES_URL wins (the workflow passes the deployed URL);
// otherwise it's derived from the repository: in CI from GITHUB_REPOSITORY, locally from the
// origin remote. https://<owner>.github.io/<repo>, or https://<owner>.github.io for a repo
// named <owner>.github.io.
export function pagesUrl() {
  if (process.env.PAGES_URL)
    return process.env.PAGES_URL.replace(/\/$/, '')
  let repo = process.env.GITHUB_REPOSITORY
  if (!repo) {
    const r = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: ROOT, encoding: 'utf8' })
    repo = r.stdout?.trim().match(/github\.com[:/]([^/]+\/[^/]+?)(\.git)?$/)?.[1]
  }
  if (!repo)
    throw new Error('Cannot tell the GitHub Pages URL: set PAGES_URL or GITHUB_REPOSITORY (owner/repo)')
  const [owner, name] = repo.split('/')
  const host = `${owner.toLowerCase()}.github.io`
  return name.toLowerCase() === host ? `https://${host}` : `https://${host}/${name}`
}

interface Channel { service: 'instagram' | 'youtube' | 'facebook' | 'twitter', name: string, id: string, key: string }
interface Config { channels: Channel[] }
interface Saved { id: string, dueAt: string, status: string, error?: string }

function loadEnv() {
  const env = join(ROOT, '.env')
  if (!existsSync(env))
    return
  for (const line of readFileSync(env, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m && !process.env[m[1]])
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}

async function gql(keyName: string, query: string, variables: Record<string, unknown>) {
  const key = process.env[keyName]
  if (!key)
    throw new Error(`${keyName} is not set`)
  for (let attempt = 1; ; attempt++) {
    const res = await fetch('https://api.buffer.com', {
      method: 'POST',
      signal: AbortSignal.timeout(60_000),
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    })
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      const wait = Number(res.headers.get('retry-after')) || 20
      await new Promise(r => setTimeout(r, Math.min(wait, 120) * 1000))
      continue
    }
    const body: any = await res.json().catch(() => ({}))
    if (!res.ok || body.errors)
      throw new Error(`Buffer ${res.status}: ${JSON.stringify(body.errors ?? body).slice(0, 300)}`)
    return body.data
  }
}

const CREATE = `mutation Create($input: CreatePostInput!) {
  createPost(input: $input) {
    __typename
    ... on PostActionSuccess { post { id status dueAt } }
    ... on MutationError { message }
  }
}`
const STATUS = `query Status($input: PostInput!) { post(input: $input) { id status dueAt sentAt externalLink error { message } } }`
const DELETE = `mutation Delete($input: DeletePostInput!) { deletePost(input: $input) { __typename ... on MutationError { message } } }`

// The text and network settings for one channel.
export function postInput(ch: Channel, reel: Reel, url: string, dueAt: string) {
  const tags = reel.post.hashtags.join(' ')
  const caption = `${reel.post.caption.trim()}\n\n${tags}`
  const base = {
    channelId: ch.id,
    schedulingType: 'automatic',
    mode: 'customScheduled',
    dueAt,
    needsApproval: false,
    source: 'mummy-is-typing',
    // the cover card at the end of the reel (engine/timeline.js); Buffer only takes a frame offset, not an image
    assets: [{ video: { url, metadata: { thumbnailOffset: timeline(reel).thumbMs } } }],
  }
  switch (ch.service) {
    case 'instagram':
      return { ...base, text: caption, metadata: { instagram: { type: 'reel', shouldShareToFeed: true } } }
    case 'facebook':
      return { ...base, text: caption, metadata: { facebook: { type: 'reel' } } }
    case 'youtube':
      return { ...base, text: caption, metadata: { youtube: { title: reel.post.youtubeTitle.slice(0, 100), categoryId: '22', privacy: 'public', madeForKids: false, notifySubscribers: true } } }
    case 'twitter':
      return { ...base, text: `${reel.post.caption.split('\n')[0]} ${BRAND.hashtag}`.slice(0, 280) }
  }
}

// The video's slot time (its id is <date>-<HHMM>, see scripts/slot.mjs) as UTC; never less than 10 minutes from now.
export function dueAtFor(date: string) {
  const at = postTime(date)
  return new Date(Math.max(at, Date.now() + 10 * 60e3)).toISOString()
}

export async function post(date: string, opts: { only?: string, at?: string, url?: string, dry?: boolean } = {}) {
  loadEnv()
  const cfg: Config = JSON.parse(readFileSync(join(ROOT, 'brand/channels.json'), 'utf8'))
  const reel: Reel = JSON.parse(readFileSync(join(ROOT, 'reels', `${date}.json`), 'utf8'))
  const url = opts.url ?? `${pagesUrl()}/${date}.mp4`
  const dueAt = opts.at ?? dueAtFor(date)
  const savedFile = join(ROOT, 'data/posts', `${date}.json`)
  const saved: Record<string, Saved> = existsSync(savedFile) ? JSON.parse(readFileSync(savedFile, 'utf8')) : {}

  if (!opts.dry) {
    const head = await fetch(url, { method: 'HEAD' })
    if (!head.ok || !(head.headers.get('content-type') ?? '').startsWith('video/mp4'))
      throw new Error(`${url} is not serving the video (${head.status} ${head.headers.get('content-type')})`)
  }

  const failures: string[] = []
  for (const ch of cfg.channels.filter(c => !opts.only || c.service === opts.only)) {
    if (saved[ch.service] && saved[ch.service].status !== 'error') {
      console.log(`  ${ch.service}: already scheduled (${saved[ch.service].id})`)
      continue
    }
    const input = postInput(ch, reel, url, dueAt)
    if (opts.dry) {
      console.log(`  ${ch.service} (${ch.key}):\n${JSON.stringify(input, null, 2).replace(/^/gm, '    ')}`)
      continue
    }
    try {
      const r = (await gql(ch.key, CREATE, { input })).createPost
      if (r.__typename !== 'PostActionSuccess')
        throw new Error(`${r.__typename}: ${r.message ?? ''}`)
      saved[ch.service] = { id: r.post.id, dueAt: r.post.dueAt, status: r.post.status }
      console.log(`  ${ch.service}: ${r.post.status} for ${r.post.dueAt} (${r.post.id})`)
    }
    catch (err) {
      failures.push(`${ch.service}: ${(err as Error).message}`)
      console.log(`  ${ch.service}: FAILED ${(err as Error).message}`)
    }
    mkdirSync(join(ROOT, 'data/posts'), { recursive: true })
    writeFileSync(savedFile, `${JSON.stringify(saved, null, 2)}\n`)
  }
  return { failures, saved }
}

export async function status(date: string) {
  loadEnv()
  const cfg: Config = JSON.parse(readFileSync(join(ROOT, 'brand/channels.json'), 'utf8'))
  const savedFile = join(ROOT, 'data/posts', `${date}.json`)
  const saved: Record<string, Saved> = existsSync(savedFile) ? JSON.parse(readFileSync(savedFile, 'utf8')) : {}
  const out: Record<string, { status: string, link?: string, error?: string }> = {}
  for (const [service, s] of Object.entries(saved)) {
    const ch = cfg.channels.find(c => c.service === service)!
    const p = (await gql(ch.key, STATUS, { input: { id: s.id } })).post
    out[service] = { status: p?.status ?? 'missing', link: p?.externalLink ?? undefined, error: p?.error?.message ?? undefined }
  }
  return out
}

// Catch a newly added channel up: every video that went to another channel but not to `service` yet,
// oldest first, scheduled `gapMinutes` apart starting 10 minutes from now.
export async function backfill(service: string, opts: { gapMinutes?: number, dry?: boolean } = {}) {
  const cfg: Config = JSON.parse(readFileSync(join(ROOT, 'brand/channels.json'), 'utf8'))
  if (!cfg.channels.some(c => c.service === service))
    throw new Error(`${service} is not in brand/channels.json`)
  const gap = (opts.gapMinutes ?? 30) * 60e3
  const dir = join(ROOT, 'data/posts')
  const ids = readdirSync(dir).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).sort()
  const todo = ids.filter((id) => {
    const saved: Record<string, Saved> = JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8'))
    const elsewhere = Object.entries(saved).some(([s, v]) => s !== service && v.status !== 'error')
    const here = saved[service] && saved[service].status !== 'error'
    return elsewhere && !here && existsSync(join(ROOT, 'reels', `${id}.json`))
  })
  console.log(`${todo.length} video(s) to send to ${service}`)
  const start = Date.now() + 10 * 60e3
  const failures: string[] = []
  for (const [i, id] of todo.entries()) {
    const at = new Date(start + i * gap).toISOString()
    console.log(`${id} at ${at}`)
    const r = await post(id, { only: service, at, dry: opts.dry })
    failures.push(...r.failures.map(f => `${id} ${f}`))
  }
  return failures
}

// Every channel each BUFFER_API_KEY_* can post to, ready to copy into brand/channels.json.
const ORGS = `{ account { organizations { id name } } }`
const CHANNELS = `query Channels($input: ChannelsInput!) { channels(input: $input) { id service name displayName isDisconnected } }`
async function listChannels() {
  loadEnv()
  const keys = Object.keys(process.env).filter(k => /^BUFFER_API_KEY_\w+$/.test(k)).sort()
  if (!keys.length)
    throw new Error('No BUFFER_API_KEY_* set (environment or .env)')
  const out: Channel[] = []
  for (const key of keys) {
    const orgs = (await gql(key, ORGS, {})).account.organizations as Array<{ id: string, name: string }>
    for (const org of orgs) {
      const chans = (await gql(key, CHANNELS, { input: { organizationId: org.id } })).channels as Array<{ id: string, service: string, name: string, displayName?: string, isDisconnected?: boolean }>
      console.log(`${key} · ${org.name}`)
      for (const c of chans) {
        console.log(`  ${c.service.padEnd(10)} ${c.id}  ${c.displayName || c.name}${c.isDisconnected ? '  (DISCONNECTED: reconnect it in Buffer)' : ''}`)
        if (['instagram', 'youtube', 'facebook', 'twitter'].includes(c.service))
          out.push({ service: c.service as Channel['service'], name: c.displayName || c.name, id: c.id, key })
      }
    }
  }
  console.log('\nFor brand/channels.json (keep one per service you want to post to):')
  console.log(JSON.stringify({ channels: out }, null, 2))
}

async function remove(date: string) {
  loadEnv()
  const cfg: Config = JSON.parse(readFileSync(join(ROOT, 'brand/channels.json'), 'utf8'))
  const savedFile = join(ROOT, 'data/posts', `${date}.json`)
  const saved: Record<string, Saved> = existsSync(savedFile) ? JSON.parse(readFileSync(savedFile, 'utf8')) : {}
  for (const [service, s] of Object.entries(saved)) {
    const ch = cfg.channels.find(c => c.service === service)!
    const r = (await gql(ch.key, DELETE, { input: { id: s.id } })).deletePost
    console.log(`  ${service}: ${r.__typename}${r.message ? ` ${r.message}` : ''}`)
    if (r.__typename === 'DeletePostSuccess')
      delete saved[service]
  }
  writeFileSync(savedFile, `${JSON.stringify(saved, null, 2)}\n`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2)
  const opt = (n: string) => {
    const i = args.indexOf(n)
    return i >= 0 ? args[i + 1] : undefined
  }
  const date = args[0]
  if (args.includes('--channels')) {
    await listChannels()
    process.exit(0)
  }
  if (args.includes('--backfill')) {
    const service = opt('--backfill')
    if (!service) {
      console.error('Usage: npm run post -- --backfill <service> [--gap <minutes>] [--dry]')
      process.exit(1)
    }
    const failures = await backfill(service, { gapMinutes: opt('--gap') ? Number(opt('--gap')) : undefined, dry: args.includes('--dry') })
    if (failures.length) {
      console.error(`✗ ${failures.length} failed:\n  ${failures.join('\n  ')}`)
      process.exit(1)
    }
    process.exit(0)
  }
  if (!date || date.startsWith('--')) {
    console.error('Usage: npm run post -- <date> [--dry] [--now] [--only <service>] [--at <ISO>] [--url <mp4>] [--status] [--check] [--delete]\n       npm run post -- --channels')
    process.exit(1)
  }
  if (args.includes('--status') || args.includes('--check')) {
    const s = await status(date)
    console.log(JSON.stringify(s, null, 2))
    // --check: fail when a post errored or vanished, so the workflow can open an issue.
    const bad = Object.entries(s).filter(([, v]) => v.status === 'error' || v.status === 'missing')
    if (args.includes('--check') && bad.length) {
      console.error(`✗ ${bad.map(([k, v]) => `${k}: ${v.status}${v.error ? ` (${v.error})` : ''}`).join('; ')}`)
      process.exit(1)
    }
  }
  else if (args.includes('--delete')) {
    await remove(date)
  }
  else {
    // --now: a few minutes from now (Buffer needs a time in the future).
    const at = args.includes('--now') ? new Date(Date.now() + 5 * 60e3).toISOString() : opt('--at')
    const r = await post(date, { only: opt('--only'), at, url: opt('--url'), dry: args.includes('--dry') })
    if (r.failures.length) {
      console.error(`✗ ${r.failures.length} channel(s) failed:\n  ${r.failures.join('\n  ')}`)
      process.exit(1)
    }
    // Mark the day as posted in the history.
    if (!args.includes('--dry') && !opt('--only')) {
      const file = join(ROOT, 'data/history.json')
      const history = JSON.parse(readFileSync(file, 'utf8'))
      for (const h of history) {
        if (h.date === date && h.status !== 'test')
          h.status = 'posted'
      }
      writeFileSync(file, `${JSON.stringify(history, null, 2)}\n`)
    }
  }
}
