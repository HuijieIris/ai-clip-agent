import './env'
import { existsSync } from 'node:fs'
import { transcribeWithVolc, volcReady } from './asr'
import { transcribeWithLocalWhisper, localWhisperAvailable } from './asr-local'
import type { TranscriptSegment } from './types'

type Provider = 'volc' | 'whisper'
type Progress = (pct: number) => void
interface ProviderResult { segments: TranscriptSegment[]; warning?: string; missingRanges?: {start:number;end:number}[] }
export interface TranscribeResult extends ProviderResult {
  source: Provider
  fallbackFrom?: 'volc'
}

// 注入仅用于隔离通道测试；生产默认复用现有转写实现。
export const defaultDependencies = {
  volcReady,
  localReady: localWhisperAvailable,
  volc: transcribeWithVolc,
  local: transcribeWithLocalWhisper,
  exists: existsSync,
}
type Dependencies = typeof defaultDependencies

function configuredProvider(): 'auto' | Provider {
  const value = process.env.ASR_PROVIDER || 'auto'
  if (value !== 'auto' && value !== 'volc' && value !== 'whisper') {
    throw new Error(`不支持 ASR_PROVIDER=${value}，请选择 auto、volc 或 whisper`)
  }
  return value
}

export function asrMode(deps: Dependencies = defaultDependencies): Provider | 'unavailable' {
  try {
    const provider = configuredProvider()
    if (provider === 'whisper') return deps.localReady() ? 'whisper' : 'unavailable'
    if (deps.volcReady()) return 'volc'
    if (provider === 'auto' && process.env.ASR_LOCAL_FALLBACK === '1' && deps.localReady()) return 'whisper'
  } catch { /* 健康检查不因配置错误崩溃；任务执行时返回具体原因。 */ }
  return 'unavailable'
}

export async function transcribe(
  audioPath: string,
  durationMs: number,
  onProgress?: Progress,
  deps: Dependencies = defaultDependencies,
): Promise<TranscribeResult> {
  if (!deps.exists(audioPath)) throw new Error('音频文件不存在，无法转写')
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error('音频时长无效')
  const provider = configuredProvider()
  const local = async (): Promise<ProviderResult> => {
    if (!deps.localReady()) throw new Error('本地 ASR 不可用，请安装并配置 Whisper')
    const result = await deps.local(audioPath, durationMs, onProgress)
    if (!result.segments.length) throw new Error('本地 ASR 未识别到有效语音')
    return result
  }
  if (provider === 'whisper') return { ...await local(), source: 'whisper' }

  let cloudError: unknown
  try {
    if (!deps.volcReady()) throw new Error('未配置火山 ASR：请设置 VOLC_API_KEY，或旧版 VOLC_APP_ID 与 VOLC_ACCESS_TOKEN')
    const result = await deps.volc(audioPath, durationMs, onProgress)
    if (!result.segments.length) throw new Error('火山 ASR 未识别到有效语音')
    return { ...result, source: 'volc' }
  } catch (error) { cloudError = error }

  const reason = cloudError instanceof Error ? cloudError.message : String(cloudError)
  if (process.env.ASR_LOCAL_FALLBACK !== '1') {
    throw new Error(`火山 ASR 失败：${reason}；本地兜底未开启（ASR_LOCAL_FALLBACK=1 可开启）`)
  }
  try {
    onProgress?.(0)
    const result = await local()
    return {
      ...result,
      source: 'whisper',
      fallbackFrom: 'volc',
      warning: [`火山 ASR 失败：${reason}；已使用本地 Whisper 兜底`, result.warning].filter(Boolean).join('；'),
    }
  } catch (error) {
    throw new Error(`火山 ASR 失败：${reason}；本地兜底失败：${error instanceof Error ? error.message : String(error)}`)
  }
}
