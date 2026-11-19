import type { Dimensions, DimensionKey, ContentSignal } from '../../../../packages/shared/highlights'
import type { TranscriptSegment } from '../types'
import { SIGNALS } from './prompts'
export function object(value: unknown, keys?: string[]): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('预期JSON对象')
  if (keys && Object.keys(value).some(k => !keys.includes(k))) throw new Error('包含未允许的字段')
  return value as Record<string, any>
}
export function list(value: unknown, max = 1000): unknown[] {
  if (!Array.isArray(value)) throw new Error('预期数组，但模型未返回数组字段')
  if (value.length > max) throw new Error(`数组超出条数限制：收到${value.length}项，最多${max}项`)
  return value
}
export function text(value: unknown, max = 2000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('文本为空或过长')
  return value.trim()
}
export function choice<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (!allowed.includes(value as T)) throw new Error(`枚举值无效，允许：${allowed.join('/')}`)
  return value as T
}
export function ids(value: unknown, segments: TranscriptSegment[], allowEmpty = false): string[] {
  const valid = new Set(segments.map(s => s.id))
  const out = list(value, segments.length).map(v => text(v, 100))
  if (!allowEmpty && !out.length) throw new Error('句子编号数组不能为空')
  if (new Set(out).size !== out.length) throw new Error('句子编号数组存在重复值')
  const unknown=out.filter(v=>!valid.has(v))
  if(unknown.length) throw new Error(`引用了不存在的句子编号：${unknown.slice(0,3).join(', ')}`)
  return out
}
export function bounds(start: unknown, end: unknown, segments: TranscriptSegment[]) {
  const a = segments.findIndex(s => s.id === start), b = segments.findIndex(s => s.id === end)
  if (a < 0 || b < a) throw new Error('起止句子不存在或顺序颠倒')
  return { a, b, start: segments[a].start, end: segments[b].end, selected: segments.slice(a, b + 1) }
}
export function validateSegments(segments: TranscriptSegment[], duration: number) {
  if (!segments.length || !Number.isFinite(duration) || duration <= 0) throw new Error('缺少真实逐字稿或有效视频时长')
  const seen = new Set<string>()
  segments.forEach((s, i) => {
    if (!s.id || seen.has(s.id) || !s.text.trim() || !Number.isInteger(s.start) || !Number.isInteger(s.end) || s.start < 0 || s.end <= s.start || s.end > duration || (i > 0 && s.start < segments[i - 1].start)) throw new Error('逐字稿编号或时间戳无效，请重新识别')
    seen.add(s.id)
  })
}
export function quote(value: unknown, segments: TranscriptSegment[]) {
  const v = object(value, ['segmentId', 'quote'])
  const segmentId = text(v.segmentId, 100)
  const original=segments.find(s=>s.id===segmentId)?.text
  if(!original) throw new Error('引用句子编号不存在')
  const q = v.quote===undefined ? original.slice(0,1000) : text(v.quote, 1000)
  if (!segments.find(s => s.id === segmentId)?.text.includes(q)) throw new Error('引用不是对应原文子串')
  return { segmentId, quote: q }
}
export const WEIGHTS: Record<DimensionKey, number> = { semantic_completeness: 25, information_value: 25, hook_potential: 20, audience_fit: 20, evidence_fidelity: 10 }
export function dimensions(value: unknown, segments: TranscriptSegment[], profile?: string): Dimensions {
  const v = object(value, Object.keys(WEIGHTS))
  const out = {} as Dimensions
  for (const key of Object.keys(WEIGHTS) as DimensionKey[]) {
    const d = object(v[key], ['score', 'reason', 'segmentIds'])
    if (!Number.isInteger(d.score) || d.score < 0 || d.score > 5) throw new Error('维度分数必须是0–5整数')
    out[key] = { score: key === 'audience_fit' && !profile ? 3 : d.score, reason: key === 'audience_fit' && !profile ? '未配置频道画像，按中性匹配处理' : text(d.reason, 400), segmentIds: (()=>{try{return ids(d.segmentIds ?? (key==='audience_fit'?[]:undefined),segments,key==='audience_fit')}catch(error){throw new Error(`评分 ${key} 的句子编号无效：${error instanceof Error?error.message:String(error)}`)}})() }
  }
  return out
}
export function score(d: Dimensions) { return Math.round((Object.keys(WEIGHTS) as DimensionKey[]).reduce((n, k) => n + WEIGHTS[k] * d[k].score / 5, 0)) }
export function signals(value: unknown, segments: TranscriptSegment[]): ContentSignal[] {
  return list(value, 12).map(item => {
    const v = object(item, ['ruleId', 'segmentIds', 'quote'])
    const ruleId = text(v.ruleId, 80)
    if (!SIGNALS.some(s => s.id === ruleId)) throw new Error('未知触发信号')
    const segmentIds = ids(v.segmentIds, segments)
    const q = v.quote===undefined ? segments.find(s=>s.id===segmentIds[0])!.text.slice(0,1000) : text(v.quote, 1000)
    if (!segments.filter(s => segmentIds.includes(s.id)).some(s => s.text.includes(q))) throw new Error('信号引用不是原文')
    return { ruleId, segmentIds, basis: 'text', quote: q }
  })
}
export function validRange(start: number, end: number, min: number, max: number, missing: {start: number; end: number}[] = []) {
  return end - start >= min && end - start <= max && !missing.some(r => r.start < end && r.end > start)
}
