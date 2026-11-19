export const HOLD: number
export const COVER: number
export const OUTRO: number
export const CLOSER: string
export interface Timeline {
  msgs: Array<{ who: 'them' | 'me', text: string, kind: string, forwarded: boolean, clock: string, at: number, first: boolean, readAt?: number, deletedAt?: number, react?: { text: string, at: number } }>
  typing: Array<[number, number, string]>
  input: Array<{ start: number, chars: number[], text: string[], sendAt: number }>
  cues: Array<{ t: number, kind: 'in' | 'out' }>
  captionAt: number | null
  coverAt: number | null
  outroAt: number | null
  thumbMs: number
  duration: number
}
export function timeline(chat: { title?: string, script: Array<{ who: string, text: string, kind?: string, forwarded?: boolean, pause?: number }>, clock?: string, caption?: string, cover?: unknown }, opts?: { caption?: boolean, cover?: boolean }): Timeline
export function ticks(m: { at: number, readAt?: number }, t: number): 'clock' | 'one' | 'two' | 'read'
