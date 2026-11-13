// One reel: reels/<id>.json. The renderer (engine/index.html) reads script, contact, clock, theme, caption.
export interface Line { who: 'them' | 'me' | 'react', text: string, pause?: number }

export interface Chat {
  title: string
  premise: string
  cast: 'mummy' | 'papa' | 'nani' | 'didi'
  clock: string
  script: Line[]
  caption: string
  post: { caption: string, hashtags: string[], youtubeTitle: string }
}

export interface Reel extends Chat {
  series: string
  contact: string // the name shown in the chat header
  theme: 'light' | 'dark'
  showCaption: boolean
}
