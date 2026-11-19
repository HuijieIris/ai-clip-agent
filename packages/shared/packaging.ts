import type { BgmSettings } from './music'
import { mapInterval, mapSubtitleInterval } from './editing'
import type { EditPlan } from './editing'
export interface TextStyle {
  font: 'sans' | 'serif' | 'shuhei'
  fontSize: number
  color: string
  highlightColor: string
  x: number
  y: number
  width: number
  lineHeight: number
  weight: number
  align: 'left' | 'center' | 'right'
  background: boolean
  outline: boolean
  outlineWidth?: number
}
export interface ChineseCue {
  id: string
  start: number
  end: number
  original: string
  text: string
  status: 'reviewed' | 'needs_review' | 'original_zh' | 'manual'
  issues: string[]
  highlights: string[]
  locked: boolean
  acknowledged?: boolean
}
export interface TitleCandidate {
  id: string
  coverTitle: string
  bodyTitle: string
  angle: string
  recommended?: boolean
  evidenceIds: string[]
}
export interface Packaging {
  titleRange?: {start:number;end:number}
  subtitleRange?: {start:number;end:number}
  subtitleOffsetMs?: number
  bgm?: BgmSettings
  version: 1
  frameLayout?:{fit:"contain"|"cover";coverViewport:{x:number;y:number;width:number;height:number};bodyViewport:{x:number;y:number;width:number;height:number};templateId:string;templateVersion:number}
  newsLayoutVersion?:1
  finalSubtitleStyle?:TextStyle
  subtitleLayoutVersion?: 2
  sourceCues: ChineseCue[]
  candidates: TitleCandidate[]
  titleLinked?: boolean
  titleModel?: string
  recommendationReason?: string
  selectedId?: string
  coverTitle: string
  bodyTitle: string
  coverLocked: boolean
  bodyLocked: boolean
  coverStyle: TextStyle
  bodyStyle: TextStyle
  subtitleStyle: TextStyle
  bodyMode: 'all' | 'intro' | 'off'
  bodyIntroMs: number
  generatedAt?: number
  channelId: string | null
  model?: string
}
export function defaultTextStyle(size = 48): TextStyle {
  return {
    font: 'sans',
    fontSize: size,
    color: '#FFFFFF',
    highlightColor: '#C9FF4D',
    x: 0.5,
    y: 0.8,
    width: 0.82,
    lineHeight: 1.4,
    weight: 700,
    align: 'center',
    background: false,
    outline: true,
  }
}
/** Split within each source interval; preserves source coordinates and does not imply word alignment. */
export function chineseOutput(packaging: Packaging, plan: EditPlan) {
  return packaging.sourceCues.flatMap((c) =>
    mapSubtitleInterval(plan.spans, c.start, c.end).flatMap((m) => {
      const lines = c.text
        .split(/(?<=[。！？!?；;，,])|\n/)
        .map((s) => s.trim())
        .filter(Boolean)
      const chunks: string[] = []
      for (const line of lines) {
        let rest = line
        while (rest.length > 20) {
          let at = Math.max(
            rest.lastIndexOf('，', 20),
            rest.lastIndexOf('。', 20),
            rest.lastIndexOf('；', 20),
          )
          if (at < 10) at = 19
          chunks.push(rest.slice(0, at + 1))
          rest = rest.slice(at + 1)
        }
        if (rest) chunks.push(rest)
      }
      if (!chunks.length) return []
      const count = chunks.reduce((n, t) => n + t.length, 0)
      let cursor = m.start
      return chunks
        .map((text, i) => {
          const start = cursor
          cursor =
            i === chunks.length - 1
              ? m.end
              : Math.min(m.end, Math.round(cursor + ((m.end - m.start) * text.length) / count))
          return { ...c, id: `${c.id}@${m.spanId}_${i}`, sourceCueId: c.id, text, start, end: cursor }
        })
        .filter((x) => x.end > x.start)
    }),
  )
}
export function packagingNeedsReview(p: Packaging, plan?: EditPlan) {
  return p.sourceCues.some(
    (c) =>
      c.status === 'needs_review' &&
      !c.acknowledged &&
      (!plan || mapInterval(plan.spans, c.start, c.end).length > 0),
  )
}

export type SubtitleMode = 'bilingual' | 'zh' | 'en'
function baseOutputSubtitles(clip: {
  subtitleMode?: SubtitleMode
  packaging?: Packaging
  editPlan?: EditPlan
  subtitles: { id: string; start: number; end: number; text: string }[]
}) {
  const mode = clip.subtitleMode ?? inferredSubtitleMode(clip)
  if (mode === 'en')
    return clip.subtitles.map((c) => ({
      ...c,
      text: subtitleDisplayText(c.text),
      english: undefined as string | undefined,
    }))
  if (clip.packaging && clip.editPlan) {
    const cues = chineseOutput(clip.packaging, clip.editPlan)
    const groupKey = (id: string) => id.slice(0, id.lastIndexOf('_'))
    return cues.map((c) => {
      const group = cues.filter((s) => groupKey(s.id) === groupKey(c.id)),
        words = c.original.trim().split(/\s+/),
        index = group.indexOf(c)
      const english =
        group.length > 1 && words.length >= group.length
          ? words
              .slice(
                Math.floor((index * words.length) / group.length),
                Math.floor(((index + 1) * words.length) / group.length),
              )
              .join(' ')
          : c.original
      return {
        ...c,
        text: subtitleDisplayText(c.text),
        english: mode === 'bilingual' ? subtitleDisplayText(english) : undefined,
      }
    })
  }
  return clip.subtitles.map((c) => ({
    ...c,
    text: /[a-zA-Z]{3}/.test(c.text) ? '' : subtitleDisplayText(c.text),
    english: undefined as string | undefined,
  }))
}
export function outputSubtitles(clip: Parameters<typeof baseOutputSubtitles>[0]) {
 const offset=clip.packaging?.subtitleOffsetMs??0,range=clip.packaging?.subtitleRange
 return baseOutputSubtitles(clip).map(c=>({...c,start:Math.max(0,range?.start??0,c.start+offset),end:Math.min(range?.end??Infinity,c.end+offset)})).filter(c=>c.end>c.start)
}
export function inferredSubtitleMode(clip: { subtitles: { text: string }[] }): SubtitleMode {
  const text = clip.subtitles.map((c) => c.text).join(' '),
    latin = (text.match(/[a-zA-Z]/g) || []).length,
    han = (text.match(/[\u3400-\u9fff]/g) || []).length
  return latin > han * 2 ? 'bilingual' : 'zh'
}

/** 仅用于展示/烧录，原文和译文原件不改。保留句内标点与数字小数点。 */
export function subtitleDisplayText(text: string) {
  return text
    .split('\n')
    .map((line) => line.trim().replace(/[，。！？；：、,.!?;:]+(?=[”’"'）)】\]]*$)/gu, ''))
    .join('\n')
}

export function subtitleStyleFor(p?: Packaging): TextStyle {
  const style = p?.finalSubtitleStyle??p?.subtitleStyle ?? defaultTextStyle(32)
  return {
    ...style,
    fontSize: p?.finalSubtitleStyle||p?.subtitleLayoutVersion===2 ? style.fontSize : Math.min(32,style.fontSize),
    background: false,
    outline: true,
    outlineWidth: 15,
  }
}
