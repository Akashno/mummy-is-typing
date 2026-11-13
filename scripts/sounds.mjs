// Makes the lookalike message tones in engine/sounds/ (send.wav, receive.wav). Our own sounds, made in code.
// To use your own recordings instead, put send.mp3 / receive.mp3 (or .wav) in brand/sounds/: the preview
// and the MP4 both prefer those.
//
//   node scripts/sounds.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RATE = 48000

// a sine whose pitch slides f1 -> f2, 5 ms attack, exponential decay
function blip(out, f1, f2, dur, vol, at = 0) {
  const start = Math.round(at * RATE), n = Math.round(dur * RATE)
  let phase = 0
  for (let i = 0; i < n && start + i < out.length; i++) {
    const x = i / n, f = f1 * (f2 / f1) ** x
    phase += 2 * Math.PI * f / RATE
    const env = i < RATE * 0.005 ? i / (RATE * 0.005) : 1e-4 ** x
    out[start + i] += Math.sin(phase) * vol * env
  }
}

function wav(file, samples) {
  const peak = Math.max(...samples.map(Math.abs)) || 1
  const pcm = Buffer.alloc(samples.length * 2)
  samples.forEach((s, i) => pcm.writeInt16LE(Math.round((s / peak) * 0.6 * 32767), i * 2))
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28)
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, Buffer.concat([h, pcm]))
  console.log(file)
}

const send = new Array(Math.round(0.12 * RATE)).fill(0)
blip(send, 700, 1150, 0.07, 1) // short rising pop
wav(path.join(ROOT, 'engine/sounds/send.wav'), send)

const receive = new Array(Math.round(0.2 * RATE)).fill(0)
blip(receive, 1250, 900, 0.06, 1) // soft double tock
blip(receive, 1650, 1200, 0.08, 0.75, 0.07)
wav(path.join(ROOT, 'engine/sounds/receive.wav'), receive)
