import { mapInterval, mapSubtitleInterval, timeMap } from '../../../../packages/shared/editing'
import type { EditPlan, SourceSpan } from '../../../../packages/shared/editing'
import type { Clip, Project } from '../types'
import { splitTimedSegment } from '../text'
export class EditError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message)
  }
}
export function validateSpans(value: unknown, duration: number): SourceSpan[] {
  if (!Array.isArray(value) || !value.length || value.length > 100) throw new EditError('保留区间需为1–100段')
  const seen = new Set<string>()
  return value.map((s, i) => {
    if (
      !s ||
      !Number.isInteger(s.sourceIn) ||
      !Number.isInteger(s.sourceOut) ||
      s.sourceIn < 0 ||
      s.sourceOut <= s.sourceIn ||
      s.sourceOut > duration
    )
      throw new EditError('源片区间非法或越界')
    if (i && s.sourceIn < value[i - 1].sourceOut)
      throw new EditError('本阶段保留区间须按原片顺序排列且不能重叠')
    const id =
      typeof s.id === 'string' && /^[\w-]{1,100}$/.test(s.id)
        ? s.id
        : `span_${i}_${s.sourceIn}_${s.sourceOut}`
    if (seen.has(id)) throw new EditError('区间ID不能重复')
    seen.add(id)
    return { id, sourceIn: s.sourceIn, sourceOut: s.sourceOut }
  })
}
export function ensurePlan(project: Project, clip: Clip): EditPlan {
  if (clip.editPlan) return structuredClone(clip.editPlan)
  const saved = clip.subtitles.map((c) => ({
    id: c.id,
    start: clip.start + c.start,
    end: clip.start + c.end,
    text: c.text,
  }))
  const original = project.transcript.flatMap((s) =>
    splitTimedSegment(s).map((c, i) => ({ id: `tx_${s.id}_${i}`, start: c.start, end: c.end, text: c.text })),
  )
  const sourceSubtitles = [
    ...original.filter((c) => !saved.some((s) => s.start < c.end && s.end > c.start)),
    ...saved,
  ].sort((a, b) => a.start - b.start)
  return {
    version: 1,
    revision: 0,
    sourceAssetId: project.fileName,
    spans: [{ id: 'legacy', sourceIn: clip.start, sourceOut: clip.end }],
    durationMs: clip.end - clip.start,
    sourceSubtitles,
    sourceReplacements: clip.replacements.map((r) => ({
      ...r,
      start: clip.start + r.start,
      end: clip.start + r.end,
      assetIn: r.assetIn || 0,
    })),
    undoCount: 0,
    redoCount: 0,
  }
}
export function rebuild(clip: Clip, plan: EditPlan, sourceDuration: number): Clip {
  plan.spans = validateSpans(plan.spans, sourceDuration)
  plan.durationMs = timeMap(plan.spans).at(-1)!.outputOut
  if (plan.durationMs < 1000) throw new EditError('成片至少保留1秒')
  // 没有词级对齐的第一阶段，内部删除不能把一句字幕分成两半并重复显示其全文。
  for (let i = 1; i < plan.spans.length; i++) {
    const a = plan.spans[i - 1].sourceOut,
      b = plan.spans[i].sourceIn
    if (
      b > a &&
      plan.sourceSubtitles.some(
        (c) => c.text.trim() && c.start < b && c.end > a && (c.start < a || c.end > b),
      )
    )
      throw new EditError('删除点穿过一句字幕；本阶段请选择完整字幕边界删除，词级精剪将在语音粗剪阶段提供')
  }
  clip.editPlan = plan
  clip.start = plan.spans[0].sourceIn
  clip.end = plan.spans.at(-1)!.sourceOut
  clip.subtitles = plan.sourceSubtitles.flatMap((c) =>
    mapSubtitleInterval(plan.spans, c.start, c.end).map((m) => ({
      id: `${c.id}@${m.spanId}`,
      sourceCueId: c.id,
      start: m.start,
      end: m.end,
      text: c.text,
    })),
  )
  clip.replacements = plan.sourceReplacements.flatMap((r) =>
    mapInterval(plan.spans, r.start, r.end).map((m) => ({
      ...r,
      id: `${r.id}@${m.spanId}`,
      sourceReplacementId: r.id,
      start: m.start,
      end: m.end,
      assetIn: (r.assetIn || 0) + m.sourceIn - r.start,
    })),
  )
  return clip
}
export function deleteOutputRange(spans: SourceSpan[], start: number, end: number): SourceSpan[] {
  const mapped = timeMap(spans),
    duration = mapped.at(-1)!.outputOut
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > duration)
    throw new EditError('删除的成片时间区间非法')
  return mapped.flatMap((s) => {
    const a = Math.max(start, s.outputIn),
      b = Math.min(end, s.outputOut)
    if (b <= a) return [{ id: s.id, sourceIn: s.sourceIn, sourceOut: s.sourceOut }]
    return [
      ...(a > s.outputIn
        ? [
            {
              id: `left_${s.sourceIn}_${s.sourceIn + a - s.outputIn}`,
              sourceIn: s.sourceIn,
              sourceOut: s.sourceIn + a - s.outputIn,
            },
          ]
        : []),
      ...(b < s.outputOut
        ? [
            {
              id: `right_${s.sourceIn + b - s.outputIn}_${s.sourceOut}`,
              sourceIn: s.sourceIn + b - s.outputIn,
              sourceOut: s.sourceOut,
            },
          ]
        : []),
    ]
  })
}
