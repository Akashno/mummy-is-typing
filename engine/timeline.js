// Turns a chat (reels/<id>.json) into a timeline: when each message appears, when the other side is typing,
// when your ticks turn blue, and the sound cues. Pure and deterministic, so the browser renderer and the
// Node scripts (duration checks, the audio mix) always agree. Times are in seconds.
//
// chat.script items: { who, text, kind?, forwarded?, pause? }
//   who: 'them'   Mummy's message; "typing…" (or "recording audio…" for a voice note) shows in the header first
//        'me'     the daughter's message; text messages are typed into the input bar, then sent
//        'react'  an emoji reaction (text) on Mummy's last message
//        'time'   the clock jumps to text (HH:MM) for everything after it, e.g. a reply hours later
//   kind: 'text' (default) · 'voice' (text is the length, e.g. "0:14") · 'missed-call' (Mummy only) ·
//         'deleted' (Mummy: arrives deleted; me: sent, then deleted a moment later)
//   forwarded: true shows the "Forwarded" label
//   pause: seconds to wait before this item (optional; sensible defaults otherwise)

export const HOLD = 2.4 // seconds the last message stays on screen
export const COVER = 2.0 // the cover card near the end (Instagram's cover frame is picked from it)
export const OUTRO = 3.5 // the follow / send-it-to-your-mumma card after the cover
const ENTER = 0.2 // message slide-in

// small seeded random so typing speed varies but every render of the same chat is identical
function rng(seed) {
  let s = 0
  for (const c of seed) s = (s * 31 + c.charCodeAt(0)) >>> 0
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32)
}

// Mummy's closer: after the punchline lands she sends one big 😌, a second small laugh that gives the joke time to
// sink in. Only on real renders (cover on), so the writer's 8-24 s chat length check is unchanged. A chat can
// pick its own with "closer": "🙂" or turn it off with "closer": false; skipped if Mummy already ends on an emoji.
export const CLOSER = '😌'
const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\u200d|\ufe0f|\s)+$/u

export function timeline(chat, { caption = false, cover = !!chat.cover } = {}) {
  const last = chat.script.at(-1)
  const closer = chat.closer === false ? null : (chat.closer || CLOSER)
  if (cover && closer && !(last?.who === 'them' && EMOJI_ONLY.test(last.text)))
    chat = { ...chat, script: [...chat.script, { who: 'them', text: closer, pause: 1.6 }] }

  const rand = rng(chat.title || JSON.stringify(chat.script))
  const msgs = [] // { who, text, at, first, sentTicks?, readAt?, react?: { text, at } }
  const typing = [] // [start, end, label] windows when the header says typing… / recording audio…
  const input = [] // { start, chars: [time per char], text, sendAt }
  const cues = [] // { t, kind: 'out' | 'in' }
  let t = 0
  let prevWho = null
  let clock = chat.clock

  chat.script.forEach((item, i) => {
    const prev = chat.script[i - 1]
    const kind = item.kind ?? 'text'
    if (item.who === 'time') {
      clock = item.text
      t += item.pause ?? 0.3
      prevWho = null // a new burst after a gap gets a fresh bubble tail
      return
    }
    if (item.who === 'react') {
      t += item.pause ?? 0.6
      const target = [...msgs].reverse().find(m => m.who === 'them')
      if (target) { target.react = { text: item.text, at: t }; cues.push({ t, kind: 'in' }) }
      t += 0.5
      return
    }
    const first = item.who !== prevWho
    prevWho = item.who
    const base = { who: item.who, text: item.text, kind, forwarded: !!item.forwarded, clock, first }
    if (item.who === 'them') {
      if (i === 0) { // the hook is already on screen at frame 0
        msgs.push({ ...base, at: -1 })
        t = 0.9
        return
      }
      t += item.pause ?? (prev?.who === 'them' ? 0.25 : 0.65)
      for (const m of msgs) if (m.who === 'me' && m.readAt == null) m.readAt = t
      if (kind !== 'missed-call') { // a call just rings; everything else shows typing or recording first
        const dur = kind === 'voice' ? 1.3 : kind === 'deleted' ? 0.9 : Math.min(1.9, 0.65 + [...item.text].length * 0.03)
        typing.push([t, t + dur, kind === 'voice' ? 'recording audio…' : 'typing…'])
        t += dur
      }
      msgs.push({ ...base, at: t })
      cues.push({ t, kind: 'in' })
      t += kind === 'missed-call' ? 0.8 : 0.5
    }
    else {
      t += item.pause ?? 0.6
      if (kind === 'text' || kind === 'deleted') {
        const start = t
        const chars = []
        for (const ch of [...item.text]) {
          t += 0.045 + rand() * 0.055 + (ch === ' ' ? 0.04 : 0)
          chars.push(t)
        }
        t += 0.22
        input.push({ start, chars, text: [...item.text], sendAt: t })
      }
      const m = { ...base, at: t }
      if (kind === 'deleted') { m.kind = 'text'; m.deletedAt = t + 1.2 } // she sends it, panics, deletes it
      msgs.push(m)
      cues.push({ t, kind: 'out' })
      t += kind === 'deleted' ? 1.7 : 0.5
    }
  })

  const end = msgs.at(-1)?.at ?? 0
  const captionAt = caption && chat.caption ? Math.max(t, end + ENTER) + 0.5 : null
  const held = Math.max(t, end + ENTER) + (captionAt ? 0.5 + 0.45 : 0) + HOLD
  const coverAt = cover ? held : null
  const outroAt = cover ? held + COVER : null
  const duration = held + (cover ? COVER + OUTRO : 0)
  // the frame Instagram uses as the reel's cover, in ms (Buffer's thumbnailOffset)
  const thumbMs = Math.round((coverAt != null ? coverAt + 0.7 : 1) * 1000)
  return { msgs, typing, input, cues, captionAt, coverAt, outroAt, thumbMs, duration }
}

// what a sent message's ticks show at time t
export function ticks(m, t) {
  if (m.readAt != null && t >= m.readAt) return 'read'
  if (t >= m.at + 0.65) return 'two'
  if (t >= m.at + 0.25) return 'one'
  return 'clock'
}
