export type ChannelId = 'technology' | 'ai' | 'robotics' | 'finance'
export interface ChannelProfile {
  id: ChannelId
  name: string
  audience: string
  editorialGoals: string
  protectedTerms: string[]
  policyVersion: number
}
export const CHANNELS: ChannelProfile[] = [
  {
    id: 'technology',
    name: '科技',
    audience: '关注科技产品和产业变化的读者',
    editorialGoals: '产品变化、关键技术与产业影响；区分演示和交付',
    protectedTerms: ['产品版本', '规格', '发布日期'],
    policyVersion: 1,
  },
  {
    id: 'ai',
    name: 'AI',
    audience: '关注人工智能能力、应用和产业的读者',
    editorialGoals: '能力边界、实测、成本与部署条件',
    protectedTerms: ['模型版本', '测试口径', '训练', '推理'],
    policyVersion: 1,
  },
  {
    id: 'robotics',
    name: '机器人',
    audience: '关注机器人实机能力和应用的读者',
    editorialGoals: '动作能力、任务表现、可靠性与应用条件',
    protectedTerms: ['遥操作', '自主', '仿真', '实机', '载荷'],
    policyVersion: 1,
  },
  {
    id: 'finance',
    name: '财经',
    audience: '关注财经事件、数据与产业影响的读者',
    editorialGoals: '保留发言归属、时间及数据口径，区分预测和已实现',
    protectedTerms: ['预计', '截至', '同比', '环比', '币种', '单位'],
    policyVersion: 1,
  },
]
export interface SourceSpan {
  id: string
  sourceIn: number
  sourceOut: number
}
export interface MappedSpan extends SourceSpan {
  outputIn: number
  outputOut: number
}
export interface SourceCue {
  id: string
  start: number
  end: number
  text: string
}
export interface SourceReplacement {
  id: string
  start: number
  end: number
  assetId: string
  assetName: string
  assetUrl: string
  keepAudio: boolean
  assetIn?: number
}
export interface EditPlan {
  version: 1
  revision: number
  sourceAssetId: string
  spans: SourceSpan[]
  durationMs: number
  sourceSubtitles: SourceCue[]
  sourceReplacements: SourceReplacement[]
  undoCount: number
  redoCount: number
}
export function timeMap(spans: SourceSpan[]): MappedSpan[] {
  let cursor = 0
  return spans.map((s) => {
    const result = { ...s, outputIn: cursor, outputOut: cursor + s.sourceOut - s.sourceIn }
    cursor = result.outputOut
    return result
  })
}
export function outputToSource(spans: SourceSpan[], time: number): number {
  const mapped = timeMap(spans)
  const span = mapped.find((s) => time >= s.outputIn && time < s.outputOut)
  if (span) return span.sourceIn + time - span.outputIn
  if (time === mapped.at(-1)?.outputOut) return mapped.at(-1)!.sourceOut
  throw new Error('成片时间超出范围')
}
export function sourceToOutput(spans: SourceSpan[], time: number): number | null {
  const span = timeMap(spans).find((s) => time >= s.sourceIn && time < s.sourceOut)
  return span ? span.outputIn + time - span.sourceIn : null
}
export function mapInterval(spans: SourceSpan[], start: number, end: number) {
  return timeMap(spans).flatMap((s) => {
    const a = Math.max(start, s.sourceIn),
      b = Math.min(end, s.sourceOut)
    return b > a
      ? [
          {
            spanId: s.id,
            sourceIn: a,
            sourceOut: b,
            start: s.outputIn + a - s.sourceIn,
            end: s.outputIn + b - s.sourceIn,
          },
        ]
      : []
  })
}
export function mapSubtitleInterval(spans: SourceSpan[], start: number, end: number) {
  const intervals: ReturnType<typeof mapInterval> = []
  for (const interval of mapInterval(spans, start, end)) {
    const previous = intervals.at(-1)
    if (previous?.sourceOut === interval.sourceIn) {
      previous.sourceOut = interval.sourceOut
      previous.end = interval.end
    } else intervals.push(interval)
  }
  return intervals
}
export function clipDuration(clip: { start: number; end: number; editPlan?: EditPlan }) {
  return clip.editPlan?.durationMs ?? clip.end - clip.start
}
