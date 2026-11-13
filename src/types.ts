// One reel: reels/<id>.json. The renderer (engine/index.html) reads script, contact, clock, theme, caption.
export interface Line { who: 'them' | 'me' | 'react', text: string, pause?: number }

export interface Chat {
  title: string
  premise: string
  cast: 'mummy'
  clock: string
  script: Line[]
  caption: string
  cover: { headline: string, emoji: string } // the end card, which is also Instagram's cover frame
  post: { caption: string, hashtags: string[], youtubeTitle: string }
}

export interface Reel extends Chat {
  series: string
  art: string // cover illustration id from brand/art.json
  contact: string // the name shown in the chat header
  theme: 'light' | 'dark'
  showCaption: boolean
}
