/**
 * 本地语音识别（Whisper CLI，无需任何 API Key）。
 *
 * 存在的意义：火山 ASR 需要账号与凭据，本地通道可以让功能在拿到 key 之前就跑通。
 *
 * 后端无关：默认调 `whisper`（openai-whisper），也可以把 LOCAL_WHISPER_BIN 指向
 * `whisper-cli`（whisper.cpp），后者在 Apple Silicon 上有 Metal 加速，长视频快得多。
 *
 * 与火山通道共用同一套后处理（分句、接缝去重、时长夹紧），保证字幕粒度一致。
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { uid } from './store'
import { run, sliceAudio } from './ffmpeg'
import { dedupeAdjacent, splitTimedSegment } from './text'
import type { TranscriptSegment } from './types'

const cfg = () => ({
  bin: process.env.LOCAL_WHISPER_BIN || 'whisper',
  backend: process.env.LOCAL_WHISPER_BACKEND || (basename(process.env.LOCAL_WHISPER_BIN || '').startsWith('whisper-cli') ? 'cpp' : 'python'),
  model: process.env.LOCAL_WHISPER_MODEL || 'small',
  lang: process.env.LOCAL_WHISPER_LANG || 'auto',
  /** 用一段包含热词的提示词引导识别，替代热词表 */
  prompt: process.env.LOCAL_WHISPER_PROMPT || '',
  chunkSec: Math.max(60, Number(process.env.LOCAL_WHISPER_CHUNK_SECONDS || 600)),
  concurrency: Math.max(1, Math.min(4, Number(process.env.LOCAL_WHISPER_CONCURRENCY || 2))),
  maxCueChars: Math.max(8, Number(process.env.ASR_MAX_CUE_CHARS || 20)),
  timeoutMs: Math.max(60_000, Number(process.env.LOCAL_WHISPER_TIMEOUT_MS || 3_600_000)),
})

export function localWhisperAvailable(): boolean {
  const c = cfg()
  return ['python', 'cpp'].includes(c.backend) && Boolean(Bun.which(c.bin)) && (c.backend !== 'cpp' || existsSync(c.model))
}

export function localWhisperSummary() {
  const c = cfg()
  return {
    bin: c.bin,
    backend: c.backend,
    model: c.model,
    lang: c.lang,
    chunkSec: c.chunkSec,
    concurrency: c.concurrency,
    hotwordPrompt: c.prompt ? `${c.prompt.slice(0, 30)}${c.prompt.length > 30 ? '…' : ''}` : '',
  }
}

interface CliSegment {
  start?: number
  end?: number
  text?: string
}

/** 跑一次 CLI 转写单片音频，返回句级片段 */
async function runCli(wavPath: string): Promise<{ start: number; end: number; text: string }[]> {
  const c = cfg()
  const outDir = mkdtempSync(join(tmpdir(), 'whisper-'))
  try {
    if (!['python', 'cpp'].includes(c.backend)) throw new Error('LOCAL_WHISPER_BACKEND 请选择 python 或 cpp')
    if (c.backend === 'cpp' && !existsSync(c.model)) throw new Error('whisper.cpp 的 LOCAL_WHISPER_MODEL 必须是已下载模型的文件路径')
    const prefix = join(outDir, 'transcript')
    const args = c.backend === 'cpp'
      ? ['-f', wavPath, '-m', c.model, '-l', c.lang, '-oj', '-of', prefix]
      : [wavPath, '--model', c.model, ...(c.lang === 'auto' ? [] : ['--language', c.lang]), '--output_format', 'json', '--output_dir', outDir, '--verbose', 'False', '--fp16', 'False']
    if (c.prompt) args.push(c.backend === 'cpp' ? '--prompt' : '--initial_prompt', c.prompt)

    const r = await run(c.bin, args, c.timeoutMs)
    if (r.code !== 0) {
      const tail = (r.stderr || r.stdout || '').slice(-400)
      throw new Error(`本地 Whisper 执行失败（退出码 ${r.code}）：${tail || '无输出'}`)
    }

    // CLI 输出文件名 = 输入文件基名 + .json
    const base = wavPath.split('/').pop()!.replace(/\.[^.]+$/, '')
    let jsonPath = join(outDir, `${base}.json`)
    if (!existsSync(jsonPath)) {
      const found = readdirSync(outDir).find((f) => f.endsWith('.json'))
      if (!found) throw new Error('本地 Whisper 未产出 JSON 结果')
      jsonPath = join(outDir, found)
    }

    const parsed = JSON.parse(readFileSync(jsonPath, 'utf8'))
    const raw = c.backend === 'cpp'
      ? (parsed.transcription ?? []).map((s: { offsets?: { from?: number; to?: number }; text?: string }) => ({
          start: s.offsets?.from, end: s.offsets?.to, text: s.text,
        }))
      : (parsed.segments ?? []).map((s: CliSegment) => ({
          start: Number(s.start) * 1000, end: Number(s.end) * 1000, text: s.text,
        }))
    return raw.map((s: { start: number; end: number; text?: string }) => ({
      start: Math.round(s.start), end: Math.round(s.end), text: String(s.text ?? '').trim(),
    })).filter((s: { start: number; end: number; text: string }) =>
      s.text && Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)

  } finally {
    try {
      rmSync(outDir, { recursive: true, force: true })
    } catch {}
  }
}

/**
 * 转写整段音频。
 * 长音频按 LOCAL_WHISPER_CHUNK_SECONDS 切片，逐片跑 CLI，再按片偏移合并。
 * 分片既是为了进度可观测，也是为了避免单个超长进程被系统杀掉后全盘重来。
 */
export async function transcribeWithLocalWhisper(
  audioPath: string,
  durationMs: number,
  onProgress?: (pct: number) => void
): Promise<{ segments: TranscriptSegment[]; warning?: string; missingRanges?: { start: number; end: number }[] }> {
  if (!localWhisperAvailable()) {
    throw new Error(
      `本地 Whisper 未就绪：检查执行文件「${cfg().bin}」、LOCAL_WHISPER_BACKEND，以及 cpp 模型路径`
    )
  }
  if (!existsSync(audioPath)) throw new Error('音频文件不存在，无法转写')

  const { chunkSec, maxCueChars, concurrency } = cfg()
  const totalSec = Math.max(1, durationMs / 1000)
  const chunkCount = Math.ceil(totalSec / chunkSec)
  const work = mkdtempSync(join(tmpdir(), 'whisper-chunks-'))

  const tasks: { index: number; startSec: number; path: string }[] = []
  try {
    for (let i = 0; i < chunkCount; i++) {
      const startSec = i * chunkSec
      const dur = Math.min(chunkSec, totalSec - startSec)
      if (dur <= 0) continue
      const out = join(work, `${uid('c_')}_${i}.wav`)
      const ok = await sliceAudio(audioPath, out, startSec, dur)
      if (!ok) throw new Error(`音频切片失败（第 ${i + 1}/${chunkCount} 片）`)
      tasks.push({ index: i, startSec, path: out })
    }

    const results: TranscriptSegment[][] = Array.from({ length: tasks.length }, () => [])
    const failed: number[] = []
    const failures: string[] = []
    let done = 0
    const queue = [...tasks]

    const worker = async () => {
      for (;;) {
        const t = queue.shift()
        if (!t) return
        try {
          const raw = await runCli(t.path)
          const offset = t.startSec * 1000
          results[t.index] = raw.flatMap((s) =>
            splitTimedSegment({ start: offset + s.start, end: offset + s.end, text: s.text }, maxCueChars).map((p) => ({
              id: uid('seg_'),
              start: p.start,
              end: p.end,
              text: p.text,
            }))
          )
        } catch (e: any) {
          console.error(`[whisper] 第 ${t.index + 1}/${tasks.length} 片失败：${e?.message ?? e}`)
          failed.push(t.index + 1)
          failures.push(`第 ${t.index + 1} 片：${e?.message ?? e}`)
        } finally {
          done++
          onProgress?.(Math.round((done / tasks.length) * 100))
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker))

    if (!results.some((r) => r.length)) {
      throw new Error(
        failed.length
          ? `全部 ${failed.length} 个音频分片转写失败：${failures.join("；")}`
          : '本地 Whisper 未识别到任何语音'
      )
    }

    const merged = dedupeAdjacent(
      results.flat().sort((a, b) => a.start - b.start),
      { gapMs: 2000, threshold: 0.55 }
    )
      .map((s) => ({ ...s, start: Math.max(0, s.start), end: Math.min(durationMs, s.end) }))
      .filter((s) => s.end > s.start)

    return {
      segments: merged,
      missingRanges: failed.map(index => ({start: (index-1)*chunkSec*1000, end: Math.min(durationMs,index*chunkSec*1000)})),
      warning: failed.length
        ? `第 ${failed.sort((a, b) => a - b).join('、')} 片转写失败（共 ${tasks.length} 片），对应时段字幕缺失。${failures.join("；")}`
        : undefined,
    }
  } finally {
    try {
      rmSync(work, { recursive: true, force: true })
    } catch {}
  }
}
