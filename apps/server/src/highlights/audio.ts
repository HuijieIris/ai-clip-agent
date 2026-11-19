import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AudioReview } from '../../../../packages/shared/highlights'
import { sliceAudio } from '../ffmpeg'
import { AUDIO, SYSTEM } from './prompts'
import { combineSignal } from './model'
import { object, list, text, choice } from './validation'
export interface AudioInput { audioPath: string; start: number; end: number; original: string; chinese: string }
export type AudioTool = (input: AudioInput, signal?: AbortSignal) => Promise<AudioReview>
export function parseAudio(value: unknown, start: number, end: number): AudioReview {
  const v = object(value, ['observations', 'transcriptCheck', 'issues'])
  return {
    status: 'reviewed', transcriptCheck: choice(v.transcriptCheck, ['consistent','needs_review','unknown'] as const),
    issues: list(v.issues, 20).map(i => text(i, 500)),
    observations: list(v.observations, 12).map(item => {
      const i = object(item, ['label','startMs','endMs','evidence','certainty'])
      if (!Number.isInteger(i.startMs) || !Number.isInteger(i.endMs) || i.startMs < 0 || i.endMs <= i.startMs || i.endMs > end - start) throw new Error('音频观察时间越界')
      return {label:text(i.label, 100), start:start+i.startMs, end:start+i.endMs, evidence:text(i.evidence, 500), certainty:choice(i.certainty, ['clear','uncertain'] as const)}
    }),
  }
}
export const reviewAudio: AudioTool = async (input, signal) => {
  const unavailable: AudioReview = {status:'unavailable', observations:[], transcriptCheck:'unknown', issues:['未配置原音频理解模型；文字语气线索不代表原声观测']}
  const key = process.env.AUDIO_REVIEW_API_KEY, model = process.env.AUDIO_REVIEW_MODEL
  if (!key || !model || !process.env.AUDIO_REVIEW_BASE_URL) return unavailable
  if (input.end - input.start > 120000) return {...unavailable, status:'skipped', issues:['候选超过120秒，需人工回听或分段音频分析']}
  const dir = mkdtempSync(join(tmpdir(),'highlight-audio-'))
  try {
    signal?.throwIfAborted()
    const path = join(dir,'candidate.wav')
    if (!await sliceAudio(input.audioPath,path,input.start/1000,(input.end-input.start)/1000)) throw new Error('音频片段提取失败')
    signal?.throwIfAborted()
    const encoded = readFileSync(path).toString('base64')
    if (encoded.length > 9_000_000) throw new Error('音频超出模型输入限制')
    const res = await fetch(`${process.env.AUDIO_REVIEW_BASE_URL.replace(/\/+$/,'')}/chat/completions`, {
      method:'POST', signal:combineSignal(signal), headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},
      body:JSON.stringify({model,stream:true,modalities:['text'],messages:[{role:'system',content:SYSTEM},{role:'user',content:[{type:'text',text:JSON.stringify({task:AUDIO,original:input.original,chinese:input.chinese,durationMs:input.end-input.start})},{type:'input_audio',input_audio:{data:`data:;base64,${encoded}`,format:'wav'}}]}]}),
    })
    if (!res.ok || !res.body) throw new Error(`音频理解请求失败 HTTP ${res.status}`)
    const reader = res.body.getReader(), decoder = new TextDecoder()
    let pending = '', output = '', bytes = 0, finished = false
    try {
      for (;;) {
        const {done,value} = await reader.read()
        if (value) {bytes += value.length; pending += decoder.decode(value,{stream:true})}
        if (bytes > 512000) throw new Error('音频模型输出超出限制')
        const lines = pending.split('\n'); pending = lines.pop() || ''
        for (const line of lines) {
          if (!line.startsWith('data:')) continue
          const raw = line.slice(5).trim()
          if (!raw || raw === '[DONE]') continue
          const chunk = JSON.parse(raw)
          if (chunk.error) throw new Error('音频模型返回错误')
          const c = chunk.choices?.[0]
          if (c?.finish_reason === 'length') throw new Error('音频模型输出截断')
          if (c?.finish_reason === 'stop') finished = true
          if (typeof c?.delta?.content === 'string') output += c.delta.content
        }
        if (done) break
      }
      if (!finished) throw new Error('音频模型流未完整结束')
    } finally { await reader.cancel().catch(()=>{}) }
    return parseAudio(JSON.parse(output),input.start,input.end)
  } catch (error) {
    signal?.throwIfAborted()
    return {...unavailable,status:'error',issues:[error instanceof Error ? error.message : '音频模型分析失败']}
  } finally {rmSync(dir,{recursive:true,force:true})}
}
