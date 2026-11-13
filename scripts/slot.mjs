// Videos go out at the times in brand.json `slots` (in the brand's timezone). Each video's id is its date and
// slot, e.g. 2026-11-10-1900: it names reels/<id>.json, out/<id>.mp4, the Pages URL and the history entry.
// Plain Node with no packages, so the workflow's guard job can run it right after a sparse checkout.
//
//   node scripts/slot.mjs           the next slot that still needs a video and posts 40 min to 6 h from now
//                                   (prints nothing when there is none); the scheduled runs use this
//   node scripts/slot.mjs --any     the next slot that still needs a video, however far away
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const brand = () => JSON.parse(readFileSync(join(ROOT, 'brand/brand.json'), 'utf8'))
const history = () => (existsSync(join(ROOT, 'data/history.json')) ? JSON.parse(readFileSync(join(ROOT, 'data/history.json'), 'utf8')) : [])

/** UTC milliseconds when the video with this id posts. A bare date means the last slot of that day. */
export function postTime(id, b = brand()) {
  const day = id.slice(0, 10), hhmm = id.length > 10 ? id.slice(11) : b.slots.at(-1).replace(':', '')
  return Date.parse(`${day}T00:00:00Z`) + (Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(2, 4)) - b.timezone.offsetMinutes) * 60e3
}

/** the next slot without a rendered or posted video, posting at least 40 min from now and (unless any) within 6 h */
export function nextSlot({ now = Date.now(), any = false } = {}) {
  const b = brand(), done = new Set(history().filter((e) => e.status === 'rendered' || e.status === 'posted').map((e) => e.date))
  const local = new Date(now + b.timezone.offsetMinutes * 60e3)
  for (let d = 0; d < 3; d++) {
    const day = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + d)).toISOString().slice(0, 10)
    for (const s of b.slots) {
      const id = `${day}-${s.replace(':', '')}`, at = postTime(id, b)
      if (at < now + 40 * 60e3 || done.has(id)) continue
      if (!any && at > now + 6 * 3600e3) return ''
      return id
    }
  }
  return ''
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(nextSlot({ any: process.argv.includes('--any') }))
