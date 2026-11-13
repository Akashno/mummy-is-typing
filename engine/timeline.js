// Turns a chat (reels/<id>.json) into a timeline: when each message appears, when the other side is typing,
// when your ticks turn blue, and the sound cues. Pure and deterministic, so the browser renderer and the
// Node scripts (duration checks, the audio mix) always agree. Times are in seconds.
//
// chat.script items: { who: 'them' | 'me' | 'react', text, pause? }
//   them   the contact's message; "typing…" shows in the header first
//   me     your message; it is typed into the input bar, then sent
//   react  an emoji reaction on the contact's last message
//   pause  seconds to wait before this item (optional; sensible defaults otherwise)

export const HOLD = 2.4 // seconds the last frame stays on screen
const ENTER = 0.2 // message slide-in

// small seeded random so typing speed varies but every render of the same chat is identical
function rng(seed) {
  let s = 0
  for (const c of seed) s = (s * 31 + c.charCodeAt(0)) >>> 0
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32)
}

export function timeline(chat, { caption = false } = {}) {
  const rand = rng(chat.title || JSON.stringify(chat.script))
  const msgs = [] // { who, text, at, first, sentTicks?, readAt?, react?: { text, at } }
  const typing = [] // [start, end] windows when the header says typing…
  const input = [] // { start, chars: [time per char], text, sendAt }
  const cues = [] // { t, kind: 'out' | 'in' }
  let t = 0
  let prevWho = null

  chat.script.forEach((item, i) => {
    const prev = chat.script[i - 1]
    if (item.who === 'react') {
      t += item.pause ?? 0.6
      const target = [...msgs].reverse().find(m => m.who === 'them')
      if (target) { target.react = { text: item.text, at: t }; cues.push({ t, kind: 'in' }) }
      t += 0.5
      return
    }
    const first = item.who !== prevWho
    prevWho = item.who
    if (item.who === 'them') {
      if (i === 0) { // the hook is already on screen at frame 0
        msgs.push({ who: 'them', text: item.text, at: -1, first })
        t = 0.9
        return
      }
      t += item.pause ?? (prev?.who === 'them' ? 0.25 : 0.65)
      for (const m of msgs) if (m.who === 'me' && m.readAt == null) m.readAt = t
      const dur = Math.min(1.9, 0.65 + [...item.text].length * 0.03)
      typing.push([t, t + dur])
      t += dur
      msgs.push({ who: 'them', text: item.text, at: t, first })
      cues.push({ t, kind: 'in' })
      t += 0.5
    }
    else {
      t += item.pause ?? 0.6
      const start = t
      const chars = []
      for (const ch of [...item.text]) {
        t += 0.045 + rand() * 0.055 + (ch === ' ' ? 0.04 : 0)
        chars.push(t)
      }
      t += 0.22
      input.push({ start, chars, text: [...item.text], sendAt: t })
      msgs.push({ who: 'me', text: item.text, at: t, first })
      cues.push({ t, kind: 'out' })
      t += 0.5
    }
  })

  const end = msgs.at(-1)?.at ?? 0
  const captionAt = caption && chat.caption ? Math.max(t, end + ENTER) + 0.5 : null
  const duration = Math.max(t, end + ENTER) + (captionAt ? 0.5 + 0.45 : 0) + HOLD
  return { msgs, typing, input, cues, captionAt, duration }
}

// what a sent message's ticks show at time t
export function ticks(m, t) {
  if (m.readAt != null && t >= m.readAt) return 'read'
  if (t >= m.at + 0.65) return 'two'
  if (t >= m.at + 0.25) return 'one'
  return 'clock'
}
