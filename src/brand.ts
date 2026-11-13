// The page's identity, cast and series live in brand/. Code reads them only through here.
import raw from '../brand/brand.json'
import castRaw from '../brand/cast.json'
import seriesRaw from '../brand/series.json'

export interface Brand {
  name: string
  handle: string
  hashtag: string // required in every post
  pitch: string
  audience: string
  timezone: { label: string, offsetMinutes: number }
  slots: string[] // HH:MM post times in that timezone (scripts/slot.mjs)
}
export interface Person { id: string, contact: string, who: string, texts: string }
export interface Series { id: string, contact: string, weight: number, brief: string }

export const BRAND = raw as Brand
export const CAST = castRaw as Person[]
export const SERIES = seriesRaw as Series[]
