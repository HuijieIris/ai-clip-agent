import type { Translation } from '../../../../packages/shared/highlights'
import type { TranscriptSegment } from '../types'
import { ModelOutputError } from './model'
import type { ModelClient } from './model'
import type { createSearchSession } from './search'
import { TRANSLATE, VERIFY_TRANSLATION } from './prompts'
import { object, list, text, choice } from './validation'

export function isForeign(text: string) {
  const letters = (text.match(/\p{L}/gu) || []).filter(c => !/\p{Script=Han}/u.test(c)).length
  const han = (text.match(/\p{Script=Han}/gu) || []).length
  return letters > 0 && letters > han * 2
}

// 小批量逐句映射，避免模型将长批次中相邻字幕合译后漏掉 ID。
export const TRANSLATION_BATCH_SIZE = 18
export function batches(segments: TranscriptSegment[], maxChars = 2200) {
  const out: TranscriptSegment[][] = []
  let current: TranscriptSegment[] = [], chars = 0
  for (const s of segments) {
    if (s.text.length > maxChars) throw new Error('单句文本超出模型窗口，请先细分逐字稿')
    if (current.length && (chars + s.text.length > maxChars || current.length >= TRANSLATION_BATCH_SIZE)) {
      out.push(current); current = []; chars = 0
    }
    current.push(s); chars += s.text.length
  }
  if (current.length) out.push(current)
  return out
}

function parseItems(value: unknown, batch: TranscriptSegment[], review: boolean): Translation[] {
  const v = object(value, ['items'])
  const items = list(v.items, batch.length)
  const seen = new Set<string>()
  return items.map(item => {
    const i = object(item, review ? ['segmentId', 'textZh', 'status', 'issues'] : ['segmentId', 'textZh'])
    const id = text(i.segmentId, 100)
    if (!batch.some(s => s.id === id) || seen.has(id)) throw new Error('译文句子编号不存在或重复')
    seen.add(id)
    const textZh = text(i.textZh, 4000)
    // 允许原文中的专有名词、简称、数字作为未确定译名保留；不能要求其中文化而诱导编造。
    const original = batch.find(s => s.id === id)!.text
    const normalizeTerm = (s:string) => s.toLowerCase().replace(/[\s\p{P}]/gu,'')
    const verbatimTerm = normalizeTerm(textZh) === normalizeTerm(original) && original.length <= 80
      && original.trim().split(/\s+/).length <= 4
      && /^[\p{L}\p{N}][\p{L}\p{N}\s\p{P}]*$/u.test(original.trim())
    if (!/\p{Script=Han}/u.test(textZh) && isForeign(textZh) && !verbatimTerm) throw new Error(`句子 ${id} 的译文没有中文，请输出中文或保留原专名并标记待核对`)
    if (review && i.status === 'needs_review' && (!Array.isArray(i.issues) || !i.issues.length)) throw new Error('待核对译文必须说明疑点')
    const issues = review ? list(i.issues, 20).map(v => text(v, 500)) : []
    if (verbatimTerm && isForeign(textZh)) issues.push('原文专名、简称或片语保留，需结合上下文人工核对')
    return {
      segmentId: id, textZh,
      status: verbatimTerm && isForeign(textZh) ? 'needs_review' as const : review ? choice(i.status, ['reviewed', 'needs_review'] as const) : 'needs_review' as const,
      issues,
    }
  })
}

// 完整性在编排层校验：有效译文留存，只补缺失 ID；不放宽未知/重复 ID 或字段校验。
async function completeItems(
  batch: TranscriptSegment[], model: ModelClient, review: boolean,
  input: Record<string, unknown>, signal?: AbortSignal,
): Promise<Translation[]> {
  const found = new Map<string, Translation>()
  for (let round = 0; round < 3; round++) {
    signal?.throwIfAborted()
    const pending = batch.filter(s => !found.has(s.id))
    if (!pending.length) break
    let result: Translation[]
    try {
      const drafts = Array.isArray(input.translations)
        ? (input.translations as Translation[]).filter(t => pending.some(s => s.id === t.segmentId)) : undefined
      result = await model.ask(
        review ? 'translation_review' : 'translate',
        (review ? VERIFY_TRANSLATION : TRANSLATE) + '\n必须逐一返回 requiredSegmentIds；不能合并多个ID。即使口误、笑声或无意义片语也要保留对应ID，无法确定时注明疑点。context仅作理解，不要输出context的ID。',
        { ...input, segments: pending, ...(drafts ? {translations:drafts} : {}), requiredSegmentIds: pending.map(s => s.id), expectedCount: pending.length },
        value => parseItems(value, pending, review), signal,
      )
    } catch (error) {
      // 仅对输出结构错误降拆，不重试鉴权/额度/网络等问题。
      if (!(error instanceof ModelOutputError) || pending.length <= 1) throw error
      const middle = Math.ceil(pending.length / 2)
      const left = await completeItems(pending.slice(0, middle), model, review, input, signal)
      const right = await completeItems(pending.slice(middle), model, review, input, signal)
      result = [...left, ...right]
    }
    for (const item of result) found.set(item.segmentId, item)
  }
  const missing = batch.filter(s => !found.has(s.id))
  if (missing.length) {
    // 连续遗漏的少数句子单独请求一次，仍无结果则明确失败，不填占位译文。
    if (batch.length > 1) {
      for (const s of missing) {
        const result = await completeItems([s], model, review, input, signal)
        found.set(s.id, result[0])
      }
    } else {
      throw new Error(`${review ? '译文复核' : '翻译'}仍缺少句子 ${missing[0].id}（${missing[0].start}–${missing[0].end}ms），已定向补齐，请重试高光分析`)
    }
  }
  return batch.map(s => found.get(s.id)!)
}

export async function translateTranscript(
  segments: TranscriptSegment[], model: ModelClient, search: ReturnType<typeof createSearchSession>,
  signal?: AbortSignal, onBatch?: (items: Translation[]) => void, existing: Translation[] = [],
) {
  const translated = new Map<string, Translation>()
  for (const item of existing) {
    if (segments.some(s => s.id === item.segmentId) && item.textZh?.trim()
      && ['reviewed','needs_review','original_zh'].includes(item.status)) translated.set(item.segmentId,item)
  }
  const publish = () => {
    const items = segments.flatMap(s => translated.has(s.id) ? [translated.get(s.id)!] : [])
    onBatch?.(items)
    return items
  }
  if (translated.size) publish()
  const queue = batches(segments.filter(s => !translated.has(s.id)))
  const controller = new AbortController()
  const workerSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  let failure: unknown
  const workers = Array.from({length:Math.min(3,queue.length)}, async () => {
    while (queue.length && !failure) {
      const batch = queue.shift()!
      try {
        workerSignal.throwIfAborted()
        if (!batch.some(s => isForeign(s.text))) {
          for (const s of batch) translated.set(s.id,{segmentId:s.id,textZh:s.text,status:'original_zh',issues:[]})
        } else {
          const a = segments.findIndex(s => s.id === batch[0].id)
          const b = segments.findIndex(s => s.id === batch.at(-1)!.id)
          const context = [...segments.slice(Math.max(0,a-2),a),...segments.slice(b+1,b+3)]
          const initial = await completeItems(batch,model,false,{context},workerSignal)
          const properNames = batch.map(s => s.text).join(' ').match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2}\b/g)
          const evidence = properNames?.length ? await search.search({purpose:'translation',query:`${[...new Set(properNames)].slice(0,3).join(' ')} 中文名称 术语`}) : null
          const checked = await completeItems(batch,model,true,{context,translations:initial,evidence},workerSignal)
          for (const item of checked) translated.set(item.segmentId,item)
        }
        workerSignal.throwIfAborted()
        publish()
      } catch (error) {
        if (!failure) { failure = error; controller.abort() }
      }
    }
  })
  await Promise.all(workers)
  if (failure) throw failure
  return publish()
}
