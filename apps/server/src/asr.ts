/**
 * 字节火山引擎（Volcengine）语音识别 —— 录音文件识别（大模型版）
 *
 * 长音频处理方式：按 CHUNK_SECONDS 切片，逐片提交 + 轮询，再把时间戳按片偏移拼回整体。
 * 之所以要分片：
 *   1. 单次提交的音频体积有限制，2 小时 wav 直接 base64 会有几百 MB；
 *   2. 单片失败可以只重试该片，不必整体重来。
 *
 * 认证走控制台「语音技术 → 录音文件识别」里创建的 AppID + Access Token。
 * 相关环境变量见 .env.example，全部可按实际账号调整，不写死在代码里。
 */
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { uid, DATA_DIR } from './store'
import { sliceAudio } from './ffmpeg'
import { dedupeAdjacent, splitTimedSegment } from './text'
import type { TranscriptSegment } from './types'

const cfg = () => ({
  apiKey: process.env.VOLC_API_KEY || '',
  appId: process.env.VOLC_APP_ID || '',
  token: process.env.VOLC_ACCESS_TOKEN || '',
  resourceId: process.env.VOLC_RESOURCE_ID || 'volc.bigasr.auc',
  base: (process.env.VOLC_ASR_ENDPOINT || 'https://openspeech.bytedance.com/api/v3/auc/bigmodel').replace(/\/+$/, ''),
  chunkSec: Math.max(60, Number(process.env.VOLC_CHUNK_SECONDS || 600)),
  concurrency: Math.max(1, Math.min(4, Number(process.env.VOLC_CONCURRENCY || 2))),
  requestTimeoutMs: Math.max(1000, Number(process.env.VOLC_REQUEST_TIMEOUT_MS || 30000)),
  pollIntervalMs: Math.max(500, Number(process.env.VOLC_POLL_INTERVAL_MS || 1500)),
  pollTimeoutMs: Math.max(30_000, Number(process.env.VOLC_POLL_TIMEOUT_MS || 600_000)),
  attempts: Math.max(1, Math.min(5, Number(process.env.VOLC_RETRY_ATTEMPTS || 3))),
  retryBaseMs: Math.max(200, Number(process.env.VOLC_RETRY_BASE_MS || 800)),
  /** 单条字幕建议最大字数，超出会继续断句 */
  maxCueChars: Math.max(8, Number(process.env.ASR_MAX_CUE_CHARS || 20)),
  /** 额外透传给火山的 request 字段（JSON），用于账号侧特殊能力如热词，避免猜字段名 */
  extraRequest: process.env.VOLC_EXTRA_REQUEST_JSON || '',
  cacheEnabled: process.env.ASR_CACHE !== '0',
})

export function volcReady(): boolean {
  const c = cfg()
  return Boolean(c.apiKey || (c.appId && c.token))
}

export function volcSummary() {
  const c = cfg()
  return {
    authMode: c.apiKey ? 'api-key' : 'legacy',
    appId: c.appId ? `${c.appId.slice(0, 4)}***` : '',
    endpoint: c.base,
    resourceId: c.resourceId,
    chunkSec: c.chunkSec,
    concurrency: c.concurrency,
    maxCueChars: c.maxCueChars,
    cache: c.cacheEnabled,
  }
}

/** 火山返回的状态码按文档约定：20000000=成功，20000001/20000002=处理中，其余为错误 */
const ST_OK = '20000000'
const ST_RUNNING = new Set(['20000001', '20000002', '20000003'])

interface Utterance {
  start_time?: number
  end_time?: number
  text?: string
}

function authHeaders(requestId: string) {
  const c = cfg()
  return {
    'Content-Type': 'application/json',
    ...(c.apiKey ? { 'X-Api-Key': c.apiKey } : { 'X-Api-App-Key': c.appId, 'X-Api-Access-Key': c.token }),
    'X-Api-Resource-Id': c.resourceId,
    'X-Api-Request-Id': requestId,
    'X-Api-Sequence': '-1',
  }
}

function statusOf(res: Response) {
  return {
    code: res.headers.get('X-Api-Status-Code') || '',
    message: res.headers.get('X-Api-Message') || '',
    logId: res.headers.get('X-Tt-Logid') || '',
  }
}

/** 可重试的错误（网络抖动、限流、并发超限）与不可重试（鉴权、音频本身有问题）要分开 */
export class AsrError extends Error {
  code: string
  retryable: boolean
  constructor(message: string, code: string, retryable: boolean) {
    super(message)
    this.name = 'AsrError'
    this.code = code
    this.retryable = retryable
  }
}

const RETRYABLE_CODES = new Set(['55000003', '55000004', '55000006', '20000003'])
const FATAL_CODES = new Set([
  '45000001', '45000002', '45000003', '45000004', '45000010',
  '55000001', '55000002', '55000005',
])

const CODE_HINTS: Record<string, string> = {
  '45000001': '音频为空或无法解析',
  '45000002': '音频时长超限，请调小 VOLC_CHUNK_SECONDS',
  '45000003': '音频格式不支持',
  '45000004': '音频采样率不支持',
  '45000010': '音频或授权信息无效，请先确认 AppID / Access Token',
  '55000001': 'AppID 或 Access Token 无效',
  '55000002': '资源未开通或 Resource-Id 不匹配，请确认已开通「录音文件识别大模型」',
  '55000003': '并发超限，请调小 VOLC_CONCURRENCY',
  '55000004': '请求频率超限，请稍后重试',
  '55000005': '账户欠费或额度不足',
}

/**
 * 把火山响应转成带中文原因的 AsrError。
 *
 * 重要：火山鉴权失败时 HTTP 是 401，但状态码可能仍然落在 45xxxxx 系列
 * （实测假凭据返回 45000010 "load grant: requested grant not found in SaaS storage"）。
 * 所以必须先看 HTTP 状态，不能只看业务码，否则会把鉴权问题误报成音频问题，
 * 排查时会被带偏。
 */
function toAsrError(code: string, message: string, httpStatus?: number): AsrError {
  const authLike =
    httpStatus === 401 ||
    httpStatus === 403 ||
    code === '55000001' ||
    /grant not found|invalid.*(token|key)|unauthorized/i.test(message)
  if (authLike) {
    const detail = [httpStatus ? `HTTP ${httpStatus}` : '', code ? `状态码 ${code}` : '', message].filter(Boolean).join('，')
    return new AsrError(
      `鉴权失败：语音 API Key 或旧版 AppID/Access Token 无效（${detail}）。请使用语音控制台 API Key，或旧版录音识别 AppID/Access Token；通用 AK/SK 不适用`,
      'auth',
      false
    )
  }

  const hint = CODE_HINTS[code]
  const text = hint
    ? `${hint}（火山状态码 ${code}${message ? `：${message}` : ''}）`
    : `火山返回错误：${code || '未知'} ${message}`.trim()
  return new AsrError(text, code, RETRYABLE_CODES.has(code))
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 对可重试错误做指数退避重试 */
async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const { attempts, retryBaseMs } = cfg()
  let lastErr: any
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn()
    } catch (e: any) {
      lastErr = e
      const retryable = e instanceof AsrError ? e.retryable : true
      if (!retryable || i === attempts) break
      const wait = retryBaseMs * Math.pow(2, i - 1)
      console.warn(`[asr] ${label} 第 ${i} 次失败，${wait}ms 后重试：${e?.message ?? e}`)
      await sleep(wait)
    }
  }
  throw lastErr
}

function buildRequest() {
  const base = {
    model_name: 'bigmodel',
    enable_itn: true,
    enable_punc: true,
    enable_ddc: true,
    show_utterances: true,
  }
  const extra = cfg().extraRequest
  if (!extra) return base
  try {
    const parsed = JSON.parse(extra)
    return { ...base, ...parsed }
  } catch {
    console.warn('[asr] VOLC_EXTRA_REQUEST_JSON 不是合法 JSON，已忽略')
    return base
  }
}

/** 提交单片音频（base64 直传，无需公网地址） */
async function submitChunk(wavPath: string): Promise<string> {
  const data = readFileSync(wavPath).toString('base64')
  const requestId = uid('volc_') + '-' + Date.now()
  const res = await fetch(`${cfg().base}/submit`, {
    method: 'POST',
    signal: AbortSignal.timeout(cfg().requestTimeoutMs),
    headers: authHeaders(requestId),
    body: JSON.stringify({
      user: { uid: 'ai-clip' },
      audio: { format: 'wav', codec: 'raw', rate: 16000, bits: 16, channel: 1, data },
      request: buildRequest(),
    }),
  })
  const st = statusOf(res)
  if (!res.ok || st.code !== ST_OK) {
    const bodyText = await res.text().catch(() => '')
    throw toAsrError(st.code || String(res.status), st.message || bodyText.slice(0, 200), res.status)
  }
  // 新版接口可能返回 task_id；旧版使用提交时的请求 ID。
  const result = await res.json().catch(() => null)
  return result?.task_id || requestId
}

/** 轮询查询结果，直到拿到 utterances */
async function queryChunk(requestId: string): Promise<Utterance[]> {
  const deadline = Date.now() + cfg().pollTimeoutMs
  for (;;) {
    const res = await fetch(`${cfg().base}/query`, {
      method: 'POST',
      signal: AbortSignal.timeout(Math.max(1, Math.min(cfg().requestTimeoutMs, deadline - Date.now()))),
      headers: authHeaders(requestId),
      body: JSON.stringify({}),
    })
    const st = statusOf(res)
    let body: any = null
    try {
      body = await res.json()
    } catch {
      body = null
    }

    if (res.ok && st.code === ST_OK) {
      return body?.result?.utterances ?? []
    }
    if (res.ok && ST_RUNNING.has(st.code)) {
      if (Date.now() > deadline) {
        throw new AsrError(
          `火山转写超时（${Math.round(cfg().pollTimeoutMs / 1000)}s 未返回结果），可调大 VOLC_POLL_TIMEOUT_MS`,
          'timeout',
          true
        )
      }
      await sleep(cfg().pollIntervalMs)
      continue
    }
    throw toAsrError(st.code || String(res.status), st.message, res.status)
  }
}

/** 缓存：同一段音频重复分析时不必重复付费转写 */
function cacheDir() {
  return join(DATA_DIR, 'cache', 'asr')
}

function cacheKeyFor(audioPath: string, durationMs: number): string {
  const c = cfg()
  let fingerprint = 'nostat'
  try {
    const st = statSync(audioPath)
    fingerprint = `${st.size}:${Math.round(st.mtimeMs)}`
  } catch {}
  const raw = [
    // 路径必须进 key：不同音频大小/时长可能完全一致（比如同一视频的不同切片），
    // 只靠 size+mtime 会碰撞，导致拿错别人的转写结果
    'volc-v2',
    c.base,
    audioPath,
    c.resourceId,
    fingerprint,
    durationMs,
    c.chunkSec,
    c.maxCueChars,
    c.extraRequest,
  ].join('|')
  return createHash('sha1').update(raw).digest('hex')
}

function readCache(key: string): TranscriptSegment[] | null {
  if (!cfg().cacheEnabled) return null
  const f = join(cacheDir(), `${key}.json`)
  if (!existsSync(f)) return null
  try {
    const j = JSON.parse(readFileSync(f, 'utf8'))
    return Array.isArray(j.segments) ? j.segments : null
  } catch {
    return null
  }
}

function writeCache(key: string, segments: TranscriptSegment[]) {
  if (!cfg().cacheEnabled) return
  try {
    const d = cacheDir()
    if (!existsSync(d)) mkdirSync(d, { recursive: true })
    writeFileSync(join(d, `${key}.json`), JSON.stringify({ savedAt: Date.now(), segments }))
  } catch (e: any) {
    console.warn(`[asr] 写缓存失败：${e?.message ?? e}`)
  }
}

export interface VolcTranscribeResult {
  segments: TranscriptSegment[]
  /** 部分分片失败等非致命问题，交给上层如实展示 */
  warning?: string
  fromCache?: boolean
  missingRanges?: { start: number; end: number }[]
}

/**
 * 转写整段音频。
 * @param audioPath  已抽取好的 16k 单声道 wav
 * @param durationMs 音频总时长
 * @param onProgress 0-100 进度回调（按已完成片数计算）
 */
export async function transcribeWithVolc(
  audioPath: string,
  durationMs: number,
  onProgress?: (pct: number) => void
): Promise<VolcTranscribeResult> {
  if (!volcReady()) throw new AsrError('未配置火山 ASR：请设置 VOLC_API_KEY，或旧版 VOLC_APP_ID 与 VOLC_ACCESS_TOKEN', 'config', false)
  if (!existsSync(audioPath)) throw new AsrError('音频文件不存在，无法转写', 'noaudio', false)

  const cacheKey = cacheKeyFor(audioPath, durationMs)
  const cached = readCache(cacheKey)
  if (cached && cached.length) {
    onProgress?.(100)
    return { segments: cached, fromCache: true }
  }

  const { chunkSec, maxCueChars } = cfg()
  const totalSec = Math.max(1, durationMs / 1000)
  const chunkCount = Math.ceil(totalSec / chunkSec)
  const single = chunkCount === 1

  const tmpFiles: string[] = []
  const tasks: { index: number; startSec: number; path: string }[] = []
  try {
    if (single) {
      tasks.push({ index: 0, startSec: 0, path: audioPath })
    } else {
      for (let i = 0; i < chunkCount; i++) {
        const startSec = i * chunkSec
        const dur = Math.min(chunkSec, totalSec - startSec)
        if (dur <= 0) continue
        const dir = audioPath.slice(0, audioPath.lastIndexOf('/') + 1) || '.'
        const out = join(dir, `${uid('asr_')}_${i}.wav`)
        tmpFiles.push(out)
        const ok = await sliceAudio(audioPath, out, startSec, dur)
        if (!ok) throw new AsrError(`音频切片失败（第 ${i + 1}/${chunkCount} 片）`, 'slice', false)
        tasks.push({ index: i, startSec, path: out })
      }
    }
  } catch (error) {
    for (const file of tmpFiles) { try { unlinkSync(file) } catch {} }
    throw error
  }

  const results: TranscriptSegment[][] = Array.from({ length: tasks.length }, () => [])
  const failed: number[] = []
  const failures: string[] = []
  let done = 0

  const runOne = async (t: { index: number; startSec: number; path: string }) => {
    const offset = t.startSec * 1000
    // 单片整体（提交+轮询）做一次重试，避免网络抖动导致整条视频前功尽弃
    const utts = await withRetry(`第 ${t.index + 1}/${tasks.length} 片`, async () => {
      const requestId = await submitChunk(t.path)
      return queryChunk(requestId)
    })

    const raw = utts
      .map((u) => ({
        start: Math.max(0, offset + Math.round(u.start_time ?? 0)),
        end: Math.max(0, offset + Math.round(u.end_time ?? 0)),
        text: String(u.text ?? '').trim(),
      }))
      .filter((s) => s.text.length > 0 && s.end > s.start)

    // 句级细分：ASR 一段话常常很长，切成适合字幕的长度并按字数分配时间
    results[t.index] = raw.flatMap((s) =>
      splitTimedSegment(s, maxCueChars).map((p) => ({
        id: uid('seg_'),
        start: p.start,
        end: p.end,
        text: p.text,
      }))
    )
    done++
    onProgress?.(Math.round((done / tasks.length) * 100))
  }

  try {
    let fatal: unknown
    const queue = [...tasks]
    const workers = Array.from({ length: Math.min(cfg().concurrency, queue.length) }, async () => {
      for (;;) {
        if (fatal) return
        const next = queue.shift()
        if (!next) return
        try {
          await runOne(next)
        } catch (e: any) {
          // 鉴权/配置类错误重试无意义，直接整体失败
          if (e instanceof AsrError && !e.retryable && (e.code === 'config' || e.code === 'auth')) {
            fatal = e
            return
          }
          console.error(`[asr] 第 ${next.index + 1}/${tasks.length} 片最终失败：${e?.message ?? e}`)
          failed.push(next.index + 1)
          failures.push(`第 ${next.index + 1} 片：${e?.message ?? e}`)
          done++
          onProgress?.(Math.round((done / tasks.length) * 100))
        }
      }
    })
    await Promise.all(workers)
    if (fatal) throw fatal
  } finally {
    for (const f of tmpFiles) {
      try {
        unlinkSync(f)
      } catch {}
    }
  }

  if (!results.some((r) => r.length)) {
    throw new AsrError(
      failed.length
        ? `全部 ${failed.length} 个分片均转写失败：${failures.join("；")}`
        : '火山 ASR 未返回任何识别结果',
      'empty',
      false
    )
  }

  // 拼接处去重：固定切片会切断句子，下一片会重复听到半句
  const merged = dedupeAdjacent(
    results.flat().sort((a, b) => a.start - b.start),
    { gapMs: 2000, threshold: 0.55 }
  )
    // 最后一道夹紧：ASR 偶发返回超出音频末尾的时间戳，不能带进下游
    .map((s) => ({ ...s, start: Math.max(0, s.start), end: Math.min(durationMs, s.end) }))
    .filter((s) => s.end > s.start)

  if (!merged.length) throw new AsrError('火山 ASR 没有有效时间范围内的语音结果', 'empty', false)
  // 部分失败不能缓存为完整成功，否则重试永远无法补齐缺失区间。
  if (!failed.length) writeCache(cacheKey, merged)

  return {
    segments: merged,
    missingRanges: failed.map(index => ({start: (index-1)*chunkSec*1000, end: Math.min(durationMs,index*chunkSec*1000)})),
    warning: failed.length
      ? `第 ${failed.sort((a, b) => a - b).join('、')} 片转写失败（共 ${tasks.length} 片），对应时段的字幕缺失，可点重新分析补齐。${failures.join("；")}`
      : undefined,
  }
}
