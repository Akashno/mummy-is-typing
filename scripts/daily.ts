// One reel: write the chat (one Claude call), render it, record it in data/history.json.
//
//   npm run daily                            the next slot that needs a reel (scripts/slot.mjs)
//   npm run daily -- --id 2026-11-14-1300    a given slot
//   npm run daily -- --test                  mark the history entry as a test
//
// If the render fails, the chat is rewritten once and rendered again.
import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { make } from './make'
import { nextSlot } from './slot.mjs'
import { record, write } from './write'

const arg = (name: string) => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}
const id = arg('--id') ?? nextSlot({ any: true })
const test = process.argv.includes('--test')

for (let round = 1; round <= 2; round++) {
  const file = `reels/${id}.json`
  let reelFile = round === 1 && existsSync(file) ? file : undefined
  if (!reelFile) {
    const w = await write(id, { series: arg('--series') })
    if (!w.ok) {
      console.error(`✗ ${id}: could not write a chat\n  ${w.errors.join('\n  ')}`)
      process.exit(1)
    }
    reelFile = w.file
  }
  const m = await make(reelFile)
  if (m.ok) {
    record(id, JSON.parse(readFileSync(reelFile, 'utf8')), test ? 'test' : 'rendered')
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `date=${id}\nmp4=${m.mp4}\n`)
    console.log(`✓ ${id}: ${m.mp4} (${m.duration.toFixed(1)}s)`)
    process.exit(0)
  }
  console.error(`  render failed (round ${round}):\n    ${m.errors.join('\n    ')}`)
  if (round === 1 && existsSync(file)) rmSync(file)
}
console.error(`✗ ${id}: no good reel`)
process.exit(1)
