// One reel: reels/<id>.json. The renderer (engine/index.html) reads script, contact, clock, theme, caption.
export interface Line { who: 'them' | 'me' | 'react' | 'time', text: string, kind?: 'text' | 'voice' | 'missed-call' | 'deleted', forwarded?: boolean, pause?: number }

export interface Chat {
  title: string
  premise: string
  cast: 'mummy'
  clock: string
  script: Line[]
  caption: string
  cover: { headline: string, emoji: string } // the end card, which is also Instagram's cover frame
  post: { caption: string, hashtags: string[], youtubeTitle: string }
  idea?: number // index into today's ideas.md list, when the chat is built on a real moment
}

export interface Reel extends Chat {
  series: string
  art: string // cover illustration id from brand/art.json
  contact: string // the name shown in the chat header
  theme: 'light' | 'dark'
  showCaption: boolean
  judge?: Score // the realness judge's verdict, kept for review
}

export interface Score { n: number, real: number, funny: number, tells: string[], verdict: 'pass' | 'fail', fix: string }
