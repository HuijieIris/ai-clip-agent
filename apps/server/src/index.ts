import {musicRoutes,resolveBgm,autoMusic} from './music/service'
import {applyAutoLayout} from './packaging/autolayout'
import {naturalEdit} from './editing/natural-language'
import {previewText} from './packaging/preview'
import {availableTextFonts} from './subtitles'
import { startPackaging, packagingJob, recoverPackaging, defaults } from './packaging/service'
import { chineseOutput, packagingNeedsReview, outputSubtitles, defaultTextStyle,subtitleStyleFor } from '../../../packages/shared/packaging'
import {isForeign} from './highlights/translation'
import { clipDuration, CHANNELS } from '../../../packages/shared/editing'
import { editClip, viewClip, viewProject } from './editing/service'
import { EditError } from './editing/plan'
import { adaptCanvasToFrame, validateTemplate, makeBrand, bindBrand, templateFor } from './branding/service'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/bun'
import { writeFileSync, existsSync, unlinkSync, readdirSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'
import { projects, templates, exports_, assets, uid, transaction, UPLOAD_DIR, OUTPUT_DIR, DATA_DIR } from './store'
import { probe, ffmpegAvailable, extractAudio, grabFrame, renderClip } from './ffmpeg'
import { transcribe, findHighlights, transcriptText, aiMode, asrMode } from './ai'
import { splitTimedSegment } from './text'
import { volcReady, volcSummary } from './asr'
import { localWhisperAvailable, localWhisperSummary } from './asr-local'
import { renderCuePng, renderTitlePng, composeCover, renderSubtitlePng } from './subtitles'
import type {
  Project, FrameTemplate, Clip, ExportJob, AnalysisTask, TranscriptSegment, SubtitleCue, ClipCover,
} from './types'

const app = new Hono()
app.onError((error,c)=>{if(error instanceof EditError)return c.json({error:error.message},error.status as 400|404|409);console.error(error);return c.json({error:'处理失败，请查看服务日志'},500)})
app.get('/api/channels',c=>c.json(CHANNELS))
app.use('*', cors())
app.use('/files/*',async(c,next)=>{
  let path:string
  try{path=decodeURIComponent(c.req.path)}catch{return c.notFound()}
  if(!/^\/files\/(uploads|outputs)\//.test(path)||path.split('/').some(part=>part==='..'||part==='.')||path.includes('\\'))return c.notFound()
  return next()
})
app.use('/files/*', serveStatic({ root: DATA_DIR, rewriteRequestPath: (p) => p.replace('/files', '') }))

const TASK_DEFS: { id: AnalysisTask['id']; label: string }[] = [
  { id: 'audio_extract', label: '提取音轨' },
  { id: 'transcribe', label: '语音转文字' },
  { id: 'scene_index', label: '画面索引' },
  { id: 'highlight', label: '高光片段生成' },
]

function fmt(ms: number): string {
  const t = Math.max(0, ms) / 1000
  const m = Math.floor(t / 60)
  const sec = (t % 60).toFixed(1)
  return `${String(m).padStart(2, '0')}:${sec.padStart(4, '0')}`
}

/** AI 智能推荐条数：按有效语音长度 / 期望中位时长估算，并限制在合理区间 */
function estimateCount(
  segments: { start: number; end: number; text: string }[],
  durationMs: number,
  minMs: number,
  maxMs: number
): number {
  const midMs = Math.max(5000, (minMs + maxMs) / 2)
  const speechMs = segments.length
    ? segments.reduce((n, s) => n + Math.max(0, s.end - s.start), 0)
    : durationMs * 0.6
  // 高光通常占总内容的 25%~35%，取 30%
  const raw = Math.round((speechMs * 0.3) / midMs)
  return Math.max(1, Math.min(20, raw))
}

function initTasks(): AnalysisTask[] {
  return TASK_DEFS.map((t) => ({ ...t, status: 'pending', progress: 0 }))
}

function fileUrl(name: string) {
  return `/files/uploads/${name}`
}
function outUrl(name: string) {
  return `/files/outputs/${name}`
}

function safeName(n: string) {
  return n.replace(/[^\w.\-]+/g, '_')
}

// ---------- 健康检查 / 能力探测 ----------
app.get('/api/health', async (c) => {
  return c.json({
    ok: true,
    ffmpeg: await ffmpegAvailable(),
    aiMode: aiMode(), // 配置探测；实际模型调用结果记录在分析批次
    asrMode: asrMode(), // 配置可用性，不代表线上鉴权或模型推理已通过
    asrLocalFallback: process.env.ASR_LOCAL_FALLBACK === '1',
    asr: volcReady() ? volcSummary() : null,
    localWhisper: localWhisperAvailable() ? localWhisperSummary() : null,
    storage: { uploads: UPLOAD_DIR, outputs: OUTPUT_DIR },
  })
})

/** 流式把 multipart 单个文件写入磁盘，避免大文件整块进内存 */
async function streamMultipartToFile(
  req: Request,
  destPath: string,
  maxBytes = 2 * 1024 ** 3
): Promise<{ ok: true; filename: string; size: number } | { ok: false; error: string }> {
  const ct = req.headers.get('content-type') ?? ''
  const m = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/)
  if (!m) return { ok: false, error: '请求缺少 multipart boundary' }
  const boundary = `--${m[1] ?? m[2]}`
  if (!req.body) return { ok: false, error: '请求体为空' }

  const reader = req.body.getReader()
  const file = Bun.file(destPath)
  const writer = file.writer()
  let state: 'preamble' | 'headers' | 'body' = 'preamble'
  let buf = new Uint8Array(0)
  let size = 0
  let filename = 'upload'
  const boundaryBytes = new TextEncoder().encode(boundary)
  const CRLF2 = new TextEncoder().encode('\r\n\r\n')

  const indexOf = (hay: Uint8Array, needle: Uint8Array, from = 0) => {
    outer: for (let i = from; i <= hay.length - needle.length; i++) {
      for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer
      return i
    }
    return -1
  }
  const concat = (a: Uint8Array, b: Uint8Array) => {
    const out = new Uint8Array(a.length + b.length)
    out.set(a, 0)
    out.set(b, a.length)
    return out
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (value) buf = concat(buf, value)
      let progressed = true
      while (progressed) {
        progressed = false
        if (state !== 'body') {
          const hi = indexOf(buf, CRLF2)
          if (hi >= 0) {
            const head = new TextDecoder().decode(buf.slice(0, hi))
            const fn = head.match(/filename="([^"]*)"/)
            if (fn) filename = fn[1]
            buf = buf.slice(hi + 4)
            state = 'body'
            progressed = true
          }
        } else {
          const bi = indexOf(buf, boundaryBytes)
          if (bi >= 0) {
            // 写掉 boundary 之前的内容，去掉尾部 CRLF
            const chunk = buf.slice(0, Math.max(0, bi - 2))
            if (chunk.length) {
              writer.write(chunk)
              size += chunk.length
            }
            await writer.end()
            return { ok: true, filename, size }
          }
          // 保留 boundary.length+4 字节尾部以防截断
          const keep = boundaryBytes.length + 4
          if (buf.length > keep) {
            const chunk = buf.slice(0, buf.length - keep)
            writer.write(chunk)
            size += chunk.length
            if (size > maxBytes) {
              await writer.end()
              return { ok: false, error: '文件超过 2GB 上限' }
            }
            buf = buf.slice(buf.length - keep)
          }
        }
      }
      if (done) break
    }
    await writer.end()
    return { ok: false, error: '上传数据不完整' }
  } catch (e: any) {
    try { await writer.end() } catch {}
    return { ok: false, error: `写入失败：${e?.message ?? e}` }
  }
}

// ---------- 上传视频 ----------
app.post('/api/upload/video', async (c) => {
  const tmpName = `${uid('tmp_')}.part`
  const tmpPath = join(UPLOAD_DIR, tmpName)
  const r = await streamMultipartToFile(c.req.raw, tmpPath)
  if (!r.ok) {
    if (existsSync(tmpPath)) unlinkSync(tmpPath)
    return c.json({ error: r.error }, 400)
  }
  const ext = extname(r.filename) || '.mp4'
  const allowed = ['.mp4', '.mov', '.mkv', '.webm', '.m4v', '.avi']
  if (!allowed.includes(ext.toLowerCase())) {
    unlinkSync(tmpPath)
    return c.json({ error: `不支持的格式 ${ext}，请上传 ${allowed.join(' / ')}` }, 400)
  }
  const name = `${uid('v_')}${ext}`
  const path = join(UPLOAD_DIR, name)
  const { renameSync } = await import('node:fs')
  renameSync(tmpPath, path)

  const info = await probe(path)
  if (!info.duration || !info.hasVideo) {
    unlinkSync(path)
    return c.json({ error: '无法读取视频时长或轨道，文件可能损坏' }, 400)
  }
  // 生成缩略图（首帧后 1 秒），失败不影响导入
  let thumbnail: string | null = null
  const thumbName = `${name.replace(/\.[^.]+$/, '')}_thumb.jpg`
  const okThumb = await grabFrame(path, Math.min(1000, info.duration / 3), join(UPLOAD_DIR, 'frames', thumbName), 640, 360)
  if (okThumb) thumbnail = `/files/uploads/frames/${thumbName}`

  return c.json({
    fileName: name,
    originalName: r.filename,
    url: fileUrl(name),
    thumbnail,
    duration: info.duration,
    width: info.width,
    height: info.height,
    sizeBytes: r.size,
    hasAudio: info.hasAudio,
  })
})

/** 通过链接导入：下载到本地后统一处理 */
app.post('/api/upload/from-url', async (c) => {
  const { url } = await c.req.json<{ url: string }>()
  if (!url || !/^https?:\/\//.test(url)) return c.json({ error: '请输入合法的 http(s) 视频链接' }, 400)
  try {
    const res = await fetch(url, { redirect: 'follow' })
    if (!res.ok) return c.json({ error: `链接无法访问（HTTP ${res.status}）` }, 400)
    const ct = res.headers.get('content-type') ?? ''
    if (ct.includes('text/html')) {
      return c.json({ error: '该链接返回网页而非视频文件。需要具备授权的直链或平台解析能力，当前版本请下载后上传本地文件。' }, 400)
    }
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > 2 * 1024 ** 3) return c.json({ error: '文件超过 2GB 上限' }, 400)
    const ext = extname(new URL(url).pathname) || '.mp4'
    const name = `${uid('v_')}${ext}`
    const path = join(UPLOAD_DIR, name)
    writeFileSync(path, buf)
    const info = await probe(path)
    if (!info.duration || !info.hasVideo) {
      unlinkSync(path)
      return c.json({ error: '下载成功但无法解析视频轨道' }, 400)
    }
    let thumbnail: string | null = null
    const thumbName = `${name.replace(/\.[^.]+$/, '')}_thumb.jpg`
    if (await grabFrame(path, Math.min(1000, info.duration / 3), join(UPLOAD_DIR, 'frames', thumbName), 640, 360)) {
      thumbnail = `/files/uploads/frames/${thumbName}`
    }
    return c.json({
      fileName: name, originalName: url.split('/').pop() ?? name, url: fileUrl(name), thumbnail,
      duration: info.duration, width: info.width, height: info.height, sizeBytes: buf.length, hasAudio: info.hasAudio,
    })
  } catch (e: any) {
    return c.json({ error: `下载失败：${e?.message ?? '网络错误'}` }, 400)
  }
})

/** 上传后即时预估 AI 推荐切片数量（不跑转写，仅按时长与区间估算） */
app.post('/api/estimate-count', async (c) => {
  const { duration, minDuration, maxDuration } = await c.req.json<{
    duration: number; minDuration: number; maxDuration: number
  }>()
  if (!duration || !maxDuration) return c.json({ error: '参数缺失' }, 400)
  const mid = Math.max(5000, (minDuration + maxDuration) / 2)
  // 理论可切上限 = 总时长 / 单条中位时长；高光通常取其中 30%，再按可用性打 8 折
  const theoretical = duration / mid
  const byContent = Math.round(theoretical * 0.3)
  const count = Math.max(1, Math.min(20, byContent))
  const minutes = duration / 60000
  const reason =
    `视频 ${minutes.toFixed(1)} 分钟，单条 ${(minDuration / 1000) | 0}–${(maxDuration / 1000) | 0} 秒，` +
    `理论最多可切 ${Math.floor(theoretical)} 条，按高光占比约 30% 推荐 ${count} 条`
  return c.json({ count, reason })
})

// ---------- 包框 / 素材上传 ----------
app.post('/api/upload/asset', async (c) => {
  const body = await c.req.parseBody()
  const file = body['file']
  if (!(file instanceof File)) return c.json({ error: '未收到文件' }, 400)
  const isImage = file.type.startsWith('image/')
  const isVideo = file.type.startsWith('video/')
  if (!isImage && !isVideo) return c.json({ error: '仅支持图片或视频素材' }, 400)
  if (isImage && !['image/png', 'image/svg+xml', 'image/webp', 'image/jpeg'].includes(file.type)) {
    return c.json({ error: '包框素材需为透明 PNG / SVG / WebP' }, 400)
  }
  let ext = extname(file.name) || (isImage ? '.png' : '.mp4')
  let buf: Buffer = Buffer.from(await file.arrayBuffer())

  // SVG 不能直接被 ffmpeg 读取，统一转成 1080x1920 的透明 PNG
  if (ext.toLowerCase() === '.svg') {
    const { rasterizeSvg } = await import('./subtitles')
    const png = await rasterizeSvg(buf.toString('utf8'), 1080, 1920)
    if (!png) return c.json({ error: 'SVG 解析失败，请改用透明 PNG' }, 400)
    buf = png
    ext = '.png'
  }
  if (isImage && ext.toLowerCase() === '.png' && buf.length > 12 * 1024 * 1024) {
    return c.json({ error: '包框图片过大（>12MB），请压缩后重试' }, 400)
  }

  const name = `${uid('a_')}${ext}`
  const path = join(UPLOAD_DIR, 'frames', name)
  writeFileSync(path, buf)
  const url = `/files/uploads/frames/${name}`
  const asset = { id: uid('as_'), name: file.name, url, kind: isImage ? 'image' as const : 'video' as const, createdAt: Date.now() }
  assets.put(asset)
  return c.json(asset)
})

app.get('/api/assets', (c) => c.json([...assets.all()].sort((a, b) => b.createdAt - a.createdAt)))

// ---------- 模板 ----------
app.get('/api/templates', (c) =>
  c.json([...templates.all()].sort((a, b) => (b.lastUsedAt ?? b.updatedAt) - (a.lastUsedAt ?? a.updatedAt)))
)

app.get('/api/templates/:id', (c) => {
  const t = templates.get(c.req.param('id'))
  return t ? c.json(t) : c.json({ error: '模板不存在' }, 404)
})

app.post('/api/templates', async (c) => {
  const body = await c.req.json<Partial<FrameTemplate>>()
  if (!body.name?.trim()) return c.json({ error: '模板名称必填' }, 400)
  if (!body.coverFrameUrl) return c.json({ error: '请上传封面包框' }, 400)
  if (!body.bodyFrameUrl) return c.json({ error: '请上传正文包框（封面与正文不能共用一张图）' }, 400)
  const now = Date.now()
  const tpl: FrameTemplate = {
    id: uid('tpl_'),
    name: body.name.trim(),
    canvas: body.canvas ?? { width: 1080, height: 1920 },
    coverFrameAssetId: body.coverFrameAssetId ?? null,
    coverFrameUrl: body.coverFrameUrl,
    bodyFrameAssetId: body.bodyFrameAssetId ?? null,
    bodyFrameUrl: body.bodyFrameUrl,
    videoViewport: body.videoViewport ?? { x: 40, y: 300, width: 1000, height: 1340 },
    subtitleSafeArea: body.subtitleSafeArea ?? { x: 90, y: 1520, width: 900, height: 240 },
    coverTitleSafeArea: body.coverTitleSafeArea ?? { x: 100, y: 220, width: 880, height: 520 },
    defaultTransform: body.defaultTransform ?? { scale: 1, offsetX: 0, offsetY: 0 },
    createdAt: now,
    updatedAt: now,
    lastUsedAt: now,
  }
  tpl.channelIds=body.channelIds||[]
  tpl.version=1
  await adaptCanvasToFrame(tpl)
  validateTemplate(tpl)
  templates.put(tpl)
  return c.json(tpl)
})

app.patch('/api/templates/:id', async (c) => {
  const id = c.req.param('id')
  const t = templates.get(id)
  if (!t) return c.json({ error: '模板不存在' }, 404)
  const patch = await c.req.json<Partial<FrameTemplate>>()
  if ('coverFrameUrl' in patch && !patch.coverFrameUrl) return c.json({ error: '封面包框不能为空' }, 400)
  if ('bodyFrameUrl' in patch && !patch.bodyFrameUrl) return c.json({ error: '正文包框不能为空' }, 400)
  const allowed=['name','canvas','coverFrameAssetId','coverFrameUrl','bodyFrameAssetId','bodyFrameUrl','videoViewport','subtitleSafeArea','coverTitleSafeArea','defaultTransform','channelIds']
  const next={...t,...Object.fromEntries(Object.entries(patch).filter(([k])=>allowed.includes(k))),version:(t.version||1)+1,updatedAt:Date.now()}
  await adaptCanvasToFrame(next)
  validateTemplate(next)
  templates.put(next)
  return c.json(next)
})

app.delete('/api/templates/:id', (c) => {
  templates.remove(c.req.param('id'))
  return c.json({ ok: true })
})

// ---------- 项目 ----------
app.get('/api/projects', (c) => c.json([...projects.all()].sort((a, b) => b.updatedAt - a.updatedAt)))

app.get('/api/projects/:id', (c) => {
  const p = projects.get(c.req.param('id'))
  return p ? c.json(viewProject(p)) : c.json({ error: '项目不存在' }, 404)
})

app.post('/api/projects', async (c) => {
  const body = await c.req.json<{
    fileName: string; originalName: string; duration: number; width: number; height: number; sizeBytes: number
    channelId?:string;brandConfirmed?:boolean;templateId: string | null; targetRatio: string; minDuration: number; maxDuration: number; desiredCount: number
  }>()
  if (!body.fileName) return c.json({ error: '缺少视频文件' }, 400)
  if (!body.templateId) return c.json({ error: '请选择一个视频包框模板' }, 400)
  if (!templates.get(body.templateId)) return c.json({ error: '所选模板不存在' }, 404)
  if (body.minDuration >= body.maxDuration) return c.json({ error: '最短时长需小于最长时长' }, 400)
  if (body.maxDuration > body.duration) return c.json({ error: '单条最长时长相较视频总长过长' }, 400)
  // desiredCount = 0 表示 AI 智能推荐，由分析阶段按内容自动决定
  if (body.desiredCount !== 0 && (body.desiredCount < 1 || body.desiredCount > 30)) {
    return c.json({ error: '片段数量需在 1-30 之间，或选择 AI 智能推荐' }, 400)
  }

  const brand=makeBrand(body.channelId,body.templateId!,body.brandConfirmed===true)
  const channel=CHANNELS.find(c=>c.id===brand.channelId)!
  const now = Date.now()
  const p: Project = {
    id: uid('prj_'),
    brand,
    recommendationSettings:{profile:`凤凰网${channel.name}；${channel.audience}；${channel.editorialGoals}`},
    title: body.originalName.replace(/\.[^.]+$/, ''),
    fileName: body.fileName,
    sourceUrl: null,
    duration: body.duration,
    width: body.width,
    height: body.height,
    sizeBytes: body.sizeBytes,
    templateId: body.templateId,
    targetRatio: body.targetRatio,
    minDuration: body.minDuration,
    maxDuration: body.maxDuration,
    desiredCount: body.desiredCount,
    analysis: { stage: 'queued', tasks: initTasks() },
    transcript: [],
    highlights: [],
    clips: [],
    createdAt: now,
    updatedAt: now,
  }
  projects.put(p)
  templates.patch(body.templateId, { lastUsedAt: now })
  return c.json(p)
})

app.patch('/api/projects/:id/brand',async c=>{const body=await c.req.json();return c.json(viewProject(bindBrand(c.req.param('id'),body)))})

app.delete('/api/projects/:id', (c) => {
  const id = c.req.param('id')
  if (!projects.get(id)) return c.json({ error: '项目不存在' }, 404)
  projects.remove(id)
  for (const j of exports_.all().filter((x) => x.projectId === id)) exports_.remove(j.id)
  return c.json({ ok: true })
})

// ---------- AI 分析（异步任务，轮询进度） ----------
const running = new Set<string>()
const analysisControllers = new Map<string, AbortController>()

app.post('/api/projects/:id/analyze', async (c) => {
  const p = projects.get(c.req.param('id'))
  if (!p) return c.json({ error: '项目不存在' }, 404)
  if (running.has(p.id)) return c.json({ ok: true, alreadyRunning: true })
  p.analysis = { stage: 'queued', tasks: initTasks(), startedAt: Date.now() }
  // 旧结果保留至新分析成功；编辑过的 Clip 不受影响。
  if (p.highlightRun) p.highlightHistory = [...(p.highlightHistory || []), p.highlightRun].slice(-5)
  delete p.highlightRun
  projects.put(p)
  void runAnalysis(p.id)
  return c.json({ ok: true })
})

app.post('/api/projects/:id/recommend', async (c) => {
  const p = projects.get(c.req.param('id'))
  if (!p) return c.json({error:'项目不存在'},404)
  if (!p.transcript.length) return c.json({error:'没有可复用的逐字稿，请先语音识别'},400)
  if (running.has(p.id)) return c.json({error:'分析任务正在执行'},409)
  const body = await c.req.json().catch(() => ({}))
  const mode = body.searchMode ?? p.recommendationSettings?.searchMode ?? 'auto'
  if (!['off','auto','required'].includes(mode)) return c.json({error:'搜索模式无效'},400)
  if (body.profile !== undefined && (typeof body.profile !== 'string' || body.profile.length > 1000)) return c.json({error:'频道画像不能超过1000字'},400)
  if (body.recordedAt !== undefined && body.recordedAt !== '' && (typeof body.recordedAt !== 'string' || !Number.isFinite(Date.parse(body.recordedAt)))) return c.json({error:'录制日期无效'},400)
  p.recommendationSettings = {profile:body.profile ?? p.recommendationSettings?.profile, searchMode:mode, recordedAt:body.recordedAt || p.recommendationSettings?.recordedAt}
  if (p.highlightRun) p.highlightHistory = [...(p.highlightHistory || []),p.highlightRun].slice(-5)
  delete p.highlightRun
  p.analysis = {stage:'queued',tasks:initTasks(),startedAt:Date.now()}
  projects.put(p)
  void runAnalysis(p.id,true)
  return c.json({ok:true})
})

async function runAnalysis(projectId: string, reuseTranscript = false) {
  const p = projects.get(projectId)
  if (!p) return
  running.add(projectId)
  const controller = new AbortController()
  analysisControllers.set(projectId,controller)
  const setTask = (id: AnalysisTask['id'], patch: Partial<AnalysisTask>) => {
    controller.signal.throwIfAborted()
    const cur = projects.get(projectId)
    if (!cur) throw new Error('项目已删除')
    const t = cur.analysis.tasks.find((x) => x.id === id)
    if (!t) return
    Object.assign(t, patch)
    cur.analysis.stage = id
    cur.updatedAt = Date.now()
    projects.put(cur)
  }
  try {
    const srcPath = join(UPLOAD_DIR, p.fileName)

    // 1 音轨
    setTask('audio_extract', { status: 'processing', progress: 10, startedAt: Date.now() })
    const audioPath = join(UPLOAD_DIR, `${p.id}.wav`)
    const okAudio = reuseTranscript ? true : await extractAudio(srcPath, audioPath, process.env.ASR_AUDIO_FILTER)
    if (!okAudio) throw new Error('音轨提取失败或视频没有可用音轨，无法进行语音识别')
    setTask('audio_extract', { status: 'completed', progress: 100, finishedAt: Date.now() })

    // 2 转写：只接受真实识别结果，失败即停止下游高光分析。
    setTask('transcribe', { status: 'processing', progress: 5, startedAt: Date.now() })
    let segments: TranscriptSegment[] = p.transcript
    if (!reuseTranscript) {
      const r = await transcribe(audioPath, p.duration, pct => setTask('transcribe', {status:'processing',progress:Math.max(5,Math.min(99,pct))}))
      controller.signal.throwIfAborted()
      segments = r.segments
      const cur1 = projects.get(projectId)!
      cur1.transcript = segments
      cur1.translations = []
      cur1.transcriptMissingRanges = r.missingRanges || []
      projects.put(cur1)
      const label = r.source === 'volc' ? '火山引擎' : '本地 Whisper'
      setTask('transcribe',{status:'completed',progress:100,finishedAt:Date.now(),source:r.source,fallbackFrom:r.fallbackFrom,message:`${label}识别完成，共${segments.length}句${r.warning?`｜${r.warning}`:''}`})
    } else {
      setTask('transcribe',{status:'completed',progress:100,finishedAt:Date.now(),message:`复用已有${segments.length}句原文，不重复调用ASR`})
    }

    // 3 画面索引
    setTask('scene_index', { status: 'processing', progress: 30, startedAt: Date.now() })
    const idxDir = join(UPLOAD_DIR, 'frames')
    const sampled: string[] = []
    for (let i = 0; i < (reuseTranscript ? 0 : 4); i++) {
      const t = Math.round((p.duration / 4) * i + 500)
      const out = join(idxDir, `${p.id}_kf${i}.jpg`)
      if (await grabFrame(srcPath, t, out, 360, 640)) sampled.push(`/files/uploads/frames/${p.id}_kf${i}.jpg`)
      setTask('scene_index', { status: 'processing', progress: 30 + (i + 1) * 15 })
    }
    setTask('scene_index', {
      status: reuseTranscript || sampled.length ? 'completed' : 'failed',
      progress: reuseTranscript || sampled.length ? 100 : 0,
      finishedAt: Date.now(),
      message: reuseTranscript ? '本次仅重新推荐，不重新抽帧' : sampled.length ? `已抽取 ${sampled.length} 个画面关键帧` : '关键帧抽取失败',
    })

    // 4 高光
    setTask('highlight', { status: 'processing', progress: 25, startedAt: Date.now() })
    const autoCount = p.desiredCount === 0
    const effectiveCount = autoCount
      ? estimateCount(segments, p.duration, p.minDuration, p.maxDuration)
      : p.desiredCount
    const hl = await findHighlights(segments, {
      minDuration: p.minDuration, maxDuration: p.maxDuration, count: effectiveCount,
      durationMs:p.duration, audioPath, resumeRun:reuseTranscript?p.highlightHistory?.at(-1):undefined, missingRanges:projects.get(projectId)?.transcriptMissingRanges,
      ...p.recommendationSettings, signal:controller.signal,
      onProgress:message=>setTask('highlight',{message}),
    }, {onUpdate:run=>{
      const cur=projects.get(projectId)
      if(cur){cur.highlightRun=structuredClone(run);cur.translations=run.translations;projects.put(cur)}
    }})
    controller.signal.throwIfAborted()
    const cur2 = projects.get(projectId)!
    cur2.highlightRun = hl.run
    cur2.translations = hl.translations
    cur2.highlights = hl.highlights
    cur2.updatedAt = Date.now()
    projects.put(cur2)
    const asked = p.desiredCount === 0 ? effectiveCount : p.desiredCount
    const hlMessage = `生成 ${hl.highlights.length} 条候选（目标 ${asked} 条，真实模型复评）。${hl.run.warnings.join('；')}`
    setTask('highlight', {status:'completed',progress:100,finishedAt:Date.now(),message:hlMessage})

    const fin = projects.get(projectId)!
    const allOk = fin.analysis.tasks.every((t) => t.status === 'completed')
    fin.analysis.stage = allOk ? 'completed' : 'failed'
    fin.analysis.finishedAt = Date.now()
    fin.analysis.error = allOk ? undefined : '部分任务失败，可重试'
    projects.put(fin)
  } catch (e: any) {
    const cur = projects.get(projectId)
    if (cur) {
      cur.analysis.stage = controller.signal.aborted ? 'cancelled' : 'failed'
      cur.analysis.error = controller.signal.aborted ? '已取消' : e?.message ?? '分析异常'
      cur.analysis.finishedAt = Date.now()
      const busy = cur.analysis.tasks.find((t) => t.status === 'processing')
      if (busy) {
        busy.status = 'failed'
        busy.message = cur.analysis.error
        busy.finishedAt = Date.now()
      }
      projects.put(cur)
    }
  } finally {
    running.delete(projectId)
    analysisControllers.delete(projectId)
  }
}

app.post('/api/projects/:id/analyze/cancel', (c) => {
  const p = projects.get(c.req.param('id'))
  if (!p) return c.json({ error: '项目不存在' }, 404)
  analysisControllers.get(p.id)?.abort()
  p.analysis.stage = 'cancelled'
  p.analysis.error = '已取消'
  projects.put(p)
  return c.json({ ok: true })
})

// ---------- 高光筛选 ----------
app.post('/api/projects/:id/highlights', async (c) => {
  const p = projects.get(c.req.param('id'))
  if (!p) return c.json({ error: '项目不存在' }, 404)
  const body = await c.req.json<{ highlights: Project['highlights'] }>()
  p.highlights = body.highlights
  p.updatedAt = Date.now()
  projects.put(p)
  return c.json(p)
})

/** 手动框选时间段 */
app.post('/api/projects/:id/highlights/manual', async (c) => {
  const p = projects.get(c.req.param('id'))
  if (!p) return c.json({ error: '项目不存在' }, 404)
  const { start, end } = await c.req.json<{ start: number; end: number }>()
  if (!Number.isFinite(start) || !Number.isFinite(end)) return c.json({ error: '时间参数无效' }, 400)
  if (start < 0) return c.json({ error: '开始时间不能为负' }, 400)
  if (!(end > start)) return c.json({ error: '结束时间需大于开始时间' }, 400)
  if (end - start < 1000) return c.json({ error: '片段至少 1 秒' }, 400)
  if (end > p.duration) return c.json({ error: '超出原视频总时长' }, 400)
  const text = transcriptText(p.transcript, start, end)
  const h = {
    id: uid('hl_'),
    title: text.slice(0, 22) || '手动片段',
    reason: '由用户手动框选，未经过 AI 评分',
    start, end,
    score: 0,
    transcript: text,
    tags: ['手动'],
    status: 'draft' as const,
  }
  p.highlights.push(h)
  p.updatedAt = Date.now()
  projects.put(p)
  return c.json(h)
})

app.delete('/api/projects/:id/highlights/:hid', (c) => {
  const p = projects.get(c.req.param('id'))
  if (!p) return c.json({ error: '项目不存在' }, 404)
  p.highlights = p.highlights.filter((h) => h.id !== c.req.param('hid'))
  projects.put(p)
  return c.json({ ok: true })
})

/** 由选中的高光生成 clips，进入剪辑阶段 */
app.post('/api/projects/:id/clips', async (c) => {
  const p = projects.get(c.req.param('id'))
  if (!p) return c.json({ error: '项目不存在' }, 404)
  const { highlightIds } = await c.req.json<{ highlightIds: string[] }>()
  if (!Array.isArray(highlightIds)||!highlightIds.length) return c.json({ error: '请至少选择 1 条高光片段' }, 400)
  if(new Set(highlightIds).size!==highlightIds.length||highlightIds.some(id=>!p.highlights.some(h=>h.id===id)))return c.json({error:'高光片段已变化，请刷新后重新选择'},400)
  const now = Date.now()
  const clips: Clip[] = []
  for (const hid of highlightIds) {
    const h = p.highlights.find((x) => x.id === hid)
    if (!h) continue
    const existing = p.clips.find(cl=>cl.highlightId===hid)||p.clips.find((cl) => !cl.highlightId&&cl.title === h.title && cl.start === h.start && cl.end === h.end)
    if (existing) { existing.highlightId=hid;clips.push(existing); continue }
    // 再用分句做一次兜底：历史项目的逐字稿可能是旧粒度（整段一句），
    // 直接当字幕会出现一行字挂屏十几秒
    const cueMaxChars = Math.max(8, Number(process.env.ASR_MAX_CUE_CHARS || 20))
    const subtitles: SubtitleCue[] = p.transcript
      .filter((s) => s.end > h.start && s.start < h.end)
      .flatMap((s) =>
        splitTimedSegment(
          {
            start: Math.max(h.start, s.start) - h.start,
            end: Math.min(h.end, s.end) - h.start,
            text: s.text,
          },
          cueMaxChars
        ).map((c) => ({ id: uid('cue_'), start: c.start, end: c.end, text: c.text }))
      )
    const clip: Clip = {
      id: uid('clip_'),
      highlightId:hid,
      projectId: p.id,
      title: h.title,
      start: h.start,
      end: h.end,
      score: h.score,
      reason: h.reason,
      transcript: h.transcript,
      tags: h.tags,
      selected: true,
      status: 'draft',
      subtitles,
      replacements: [],
      operations: [],
      updatedAt: now,
    }
    clips.push(clip)
  }
  // 活跃批次与历史编辑分开：只切换本次列表，不删除未选片段。
  const chosen=new Map(clips.map(c=>[c.id,c]))
  p.clips=[...p.clips.map(c=>chosen.get(c.id)??c),...clips.filter(c=>!p.clips.some(old=>old.id===c.id))]
  p.activeClipIds=clips.map(c=>c.id)
  p.updatedAt = now
  projects.put(p)
  return c.json({ clips: clips.map(clip=>viewClip(p,clip)) })
})

app.patch('/api/projects/:id/clips/:clipId',async c=>{
  const body=await c.req.json()
  if('start'in body||'end'in body)throw new EditError('时间轴修改请使用编辑操作接口')
  return c.json(editClip(c.req.param('id'),c.req.param('clipId'),{...body,type:'metadata'}))
})
app.post('/api/projects/:id/clips/:clipId/ops',async c=>{
  const body=await c.req.json()
  return c.json({clip:editClip(c.req.param('id'),c.req.param('clipId'),body)})
})

/** 模型规划白名单操作，后端校验并原子执行，沿用编辑快照。 */
app.post('/api/projects/:id/clips/:clipId/nl',async c=>{const b=await c.req.json();return c.json(await naturalEdit(c.req.param('id'),c.req.param('clipId'),b.instruction,b.expectedRevision))})

app.route('/api/music',musicRoutes)
app.get('/api/packaging/fonts',c=>c.json(availableTextFonts()))
app.post('/api/projects/:id/clips/:clipId/text-preview',async c=>{const b=await c.req.json();if(!Number.isFinite(b.time)||b.time<0)throw new EditError('播放位置无效');return c.json(await previewText(c.req.param('id'),c.req.param('clipId'),b.packaging,b.time))})
app.get('/api/projects/:id/clips/:clipId/packaging',c=>{const p=projects.get(c.req.param('id')),stored=p?.clips.find(clip=>clip.id===c.req.param('clipId'));if(!p||!stored)throw new EditError('片段不存在',404);const clip=viewClip(p,stored),tpl=templateFor(p);if(!tpl)throw new EditError('模板缺失');return c.json(clip.packaging??defaults(clip,tpl,p.brand?.channelId??null))})
app.post('/api/projects/:id/clips/:clipId/presentation',async c=>{const b=await c.req.json();return c.json({clip:editClip(c.req.param('id'),c.req.param('clipId'),{...b,type:'presentation'})})})
app.post('/api/projects/:id/clips/:clipId/review-copy', async c => {
  const { expectedRevision, start, end } = await c.req.json()
  const pid = c.req.param('id')
  return transaction(() => {
    const project = projects.get(pid)
    if (!project) throw new EditError('项目不存在', 404)
    const sourceId = c.req.param('clipId')
    const source = viewProject(project).clips.find(clip => clip.id === sourceId)
    if (!source?.editPlan || source.editPlan.revision !== expectedRevision)
      throw new EditError('编辑版本已变化，请刷新后重试', 409)

    const copy = structuredClone(source)
    copy.id = uid('clip_')
    delete copy.highlightId
    copy.title = `${copy.title.slice(0, 295)}（副本）`
    copy.operations = []
    copy.editPlan!.revision = 0
    copy.editPlan!.undoCount = 0
    copy.editPlan!.redoCount = 0
    copy.updatedAt = Date.now()
    project.clips.splice(project.clips.findIndex(clip => clip.id === sourceId) + 1, 0, copy)
    if (project.activeClipIds) {
      project.activeClipIds.splice(project.activeClipIds.indexOf(sourceId) + 1, 0, copy.id)
    }
    project.updatedAt = copy.updatedAt
    projects.put(project)
    if (start !== 0 || end !== clipDuration(source))
      editClip(pid, copy.id, { type: 'review_cut', mode: 'trim', start, end, expectedRevision: 0 })
    return c.json({ project: viewProject(projects.get(pid)!), clipId: copy.id })
  })
})
app.post('/api/projects/:id/apply-review-bgm', async c => {
  const { clipId, expectedRevision, bgm } = await c.req.json()
  const pid = c.req.param('id')
  return transaction(() => {
    const project = projects.get(pid)
    if (!project) throw new EditError('项目不存在', 404)
    const clips = viewProject(project).clips
    const current = clips.find(clip => clip.id === clipId)
    if (!current || current.editPlan?.revision !== expectedRevision)
      throw new EditError('编辑版本已变化，请刷新后重试', 409)
    const template = templateFor(project)
    if (!template) throw new EditError('模板缺失')
    if (!bgm || typeof bgm !== 'object') throw new EditError('请先选择背景音乐')
    for (const clip of clips) {
      const packaging = structuredClone(clip.packaging ?? defaults(clip, template, project.brand?.channelId ?? null))
      const duration = clipDuration(clip)
      packaging.bgm = clip.id === clipId ? bgm : { ...bgm, start: 0, end: duration }
      editClip(pid, clip.id, { type: 'presentation', packaging, expectedRevision: clip.editPlan?.revision })
    }
    return c.json(viewProject(projects.get(pid)!))
  })
})
app.post('/api/projects/:id/clips/:clipId/packaging-style',async c=>{
 const b=await c.req.json(),pid=c.req.param('id'),cid=c.req.param('clipId')
 return transaction(()=>{const project=projects.get(pid);if(!project)throw new EditError('项目不存在',404);const tpl=templateFor(project);if(!tpl)throw new EditError('模板缺失')
 const current=project.clips.find(x=>x.id===cid);if(!current)throw new EditError('片段不存在',404)
 if(viewClip(project,current).editPlan!.revision!==b.expectedRevision)throw new EditError('编辑版本已变化，请刷新后重试',409)
 for(const clip of project.clips.filter(c=>!project.activeClipIds||project.activeClipIds.includes(c.id))){const p=structuredClone(clip.packaging??defaults(clip,tpl,project.brand?.channelId??null));p.coverStyle=b.coverStyle;p.bodyStyle=b.bodyStyle;p.subtitleStyle=b.subtitleStyle;if(b.finalSubtitleStyle)p.finalSubtitleStyle=b.finalSubtitleStyle;editClip(pid,clip.id,{type:'packaging',packaging:p})}
 return c.json(viewProject(projects.get(pid)!))})
})
app.post('/api/projects/:id/clips/:clipId/subtitles/prepare',c=>c.json(startPackaging(c.req.param('id'),[c.req.param('clipId')],undefined,true)))
app.post('/api/projects/:id/apply-news-text',async c=>{
 const pid=c.req.param('id'),p=projects.get(pid);if(!p)throw new EditError('项目不存在',404);const tpl=templateFor(p);if(!tpl)throw new EditError('模板不存在')
 const updates:{id:string;packaging:NonNullable<Clip['packaging']>;revision:number|undefined}[]=[];for(const clip of viewProject(p).clips){if(!clip.packaging)continue;const packaging=structuredClone(clip.packaging);delete packaging.newsLayoutVersion;await applyAutoLayout(packaging,tpl);updates.push({id:clip.id,packaging,revision:clip.editPlan?.revision})}
 return transaction(()=>{for(const u of updates)editClip(pid,u.id,{type:'packaging',packaging:u.packaging,expectedRevision:u.revision});return c.json(viewProject(projects.get(pid)!))})
})
app.post('/api/projects/:id/restore-framing',c=>{
 const pid=c.req.param('id');return transaction(()=>{const p=projects.get(pid);if(!p)throw new EditError('项目不存在',404);for(const clip of viewProject(p).clips)if(clip.packaging?.frameLayout?.fit==='contain')editClip(pid,clip.id,{type:'restore_framing',expectedRevision:clip.editPlan?.revision});return c.json(viewProject(projects.get(pid)!))})
})
app.post('/api/projects/:id/autoframe',c=>{
 const p=projects.get(c.req.param('id'));if(!p)throw new EditError('项目不存在',404)
 const clips=viewProject(p).clips;if(!clips.length)throw new EditError('没有本次选中的片段')
 if(!p.brand?.confirmedAt)throw new EditError('请先在品牌面板确认当前频道和包框，再自动套框')
 if(p.autoFrameRun&&['preparing','rendering'].includes(p.autoFrameRun.status))return c.json(p.autoFrameRun)
 const job=startPackaging(p.id,clips.map(c=>c.id),undefined,false,true)
 const run:NonNullable<Project['autoFrameRun']>={jobId:job.id,status:'preparing',message:'正在准备本批次标题、字幕和封面',clipIds:clips.map(c=>c.id),previewJobIds:[]}
 projects.patch(p.id,{autoFrameRun:run});void completeAutoFrame(p.id,job.id)
 return c.json(run)
})
app.post('/api/projects/:id/autoframe/resume',c=>{
 const p=projects.get(c.req.param('id')),run=p?.autoFrameRun;if(!p||!run?.previewJobIds.length)throw new EditError('没有可恢复的成片任务，请重新套框')
 if(JSON.stringify(viewProject(p).clips.map(c=>c.id))!==JSON.stringify(run.clipIds))throw new EditError('本次选择已变化，请重新套框')
 const jobs=run.previewJobIds.map(id=>exports_.get(id));if(jobs.some(j=>!j))throw new EditError('任务记录缺失，请重新套框')
 for(const job of jobs){const clip=p.clips.find(c=>c.id===job!.clipId);if((clip?.editPlan?.revision??0)!==job!.editRevision)throw new EditError('内容已改变，请为新版本重新套框')}
 for(const job of jobs)if(job!.status==='failed'){exports_.patch(job!.id,{status:'queued',progress:0,message:'恢复未完成的预览',updatedAt:Date.now()});runExport(job!.id,job!.withSubtitles,job!.exportCover)}
 projects.patch(p.id,{autoFrameRun:{...run,status:'rendering',message:'正在恢复未完成预览，已完成片段可先审核'}})
 void monitorAutoFrame(p.id,run.jobId)
 return c.json(projects.get(p.id)!.autoFrameRun)
})
async function monitorAutoFrame(pid:string,jobId:string){
 const deadline=Date.now()+60*60*1000
 const update=(patch:Partial<NonNullable<Project['autoFrameRun']>>)=>transaction(()=>{const p=projects.get(pid);if(p?.autoFrameRun?.jobId===jobId)projects.patch(pid,{autoFrameRun:{...p.autoFrameRun,...patch}})})
 try{while(true){const p=projects.get(pid);if(p?.autoFrameRun?.jobId!==jobId)return;const jobs=p.autoFrameRun.previewJobIds.map(id=>exports_.get(id));if(jobs.some(j=>!j))throw Error('预览任务缺失');const fail=jobs.find(j=>j?.status==='failed');if(fail)throw Error(fail.message??'渲染失败');if(jobs.length&&jobs.every(j=>j?.status==='completed'))break;if(Date.now()>deadline)throw Error('预览等待超时，可恢复未完成任务');await new Promise(r=>setTimeout(r,1000))}update({status:'completed',message:'本批次成片预览全部就绪'})}catch(e){update({status:'failed',message:e instanceof Error?e.message:'预览失败'})}
}
async function completeAutoFrame(pid:string,jobId:string){
 const update=(patch:Partial<NonNullable<Project['autoFrameRun']>>)=>transaction(()=>{const p=projects.get(pid);if(p?.autoFrameRun?.jobId!==jobId)return;projects.patch(pid,{autoFrameRun:{...p.autoFrameRun,...patch}})})
 try{
  const deadline=Date.now()+60*60*1000
  while(true){const job=packagingJob(jobId);if(!job)throw Error('套框任务缺失');if(job.status==='failed')throw Error(job.message);if(job.status==='completed')break;if(Date.now()>deadline)throw Error('套框任务超时，可重试');await new Promise(r=>setTimeout(r,700))}
  const p=projects.get(pid);if(p?.autoFrameRun?.jobId!==jobId)return
  if(JSON.stringify(viewProject(p).clips.map(c=>c.id))!==JSON.stringify(p.autoFrameRun.clipIds))throw Error('本次选择已变化，请重新确认套框')
  update({status:'rendering',message:'标题、字幕及封面已安排，正在渲染实际成片预览'})
  for(const cid of p.autoFrameRun.clipIds){try{await autoMusic(pid,cid)}catch(e){console.error('[music] 自动推荐未完成，可在成片音乐面板重试：',e instanceof Error?e.message:'音乐推荐失败')}}
  const response=await app.fetch(new Request(`http://localhost/api/projects/${pid}/export`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({clipIds:p.autoFrameRun.clipIds,ratio:'fit',resolution:'720P',withSubtitles:true,exportCover:true,preview:true})}))
  const body=await response.json() as any;if(!response.ok)throw Error(body.error??'创建成片预览失败')
  const ids=body.jobs.map((j:ExportJob)=>j.id) as string[];update({previewJobIds:ids})
  await monitorAutoFrame(pid,jobId)
 }catch(error){update({status:'failed',message:error instanceof Error?error.message:'自动套框失败'})}
}

app.post('/api/projects/:id/packaging',async c=>{const b=await c.req.json();return c.json(startPackaging(c.req.param('id'),b.clipIds,b.cueId))})
app.get('/api/packaging/:id',c=>{const job=packagingJob(c.req.param('id'));return job?c.json(job):c.json({error:'任务不存在'},404)})

// ---------- 成片（包框适配 + 封面） ----------
app.patch('/api/projects/:id/clips/:clipId/frame', async (c) => {
  const p = projects.get(c.req.param('id'))
  if (!p) return c.json({ error: '项目不存在' }, 404)
  const clip = p.clips.find((x) => x.id === c.req.param('clipId'))
  if (!clip) return c.json({ error: '片段不存在' }, 404)
  const body = await c.req.json<{ transform?: Clip['transform']; cover?: Partial<ClipCover>; applyToAll?: boolean }>()
  return transaction(()=>{
  const updated=editClip(p.id,clip.id,{type:'frame',transform:body.transform,cover:body.cover,expectedRevision:(body as any).expectedRevision})
  if(body.applyToAll&&body.transform){
    for(const other of p.clips)if(other.id!==clip.id&&(!p.activeClipIds||p.activeClipIds.includes(other.id)))editClip(p.id,other.id,{type:'frame',transform:body.transform})
  }
  return c.json({clip:updated,affected:body.applyToAll?p.clips.filter(c=>!p.activeClipIds||p.activeClipIds.includes(c.id)).length:1})
  })
})

function defaultCover(projectId: string, clip: Clip): ClipCover {
  return {
    source: 'frame',
    frameTime: clip.start + Math.min(1000, (clip.end - clip.start) / 2),
    imageUrl: null,
    title: clip.title,
    titleStyle: { fontSize: 64, color: '#FFFFFF', weight: 700, x: 0.5, y: 0.18, align: 'center' },
    firstScreenDuration: 0,
  }
}

/** 生成封面帧图片（真实抽帧） */
app.post('/api/projects/:id/clips/:clipId/cover/frame', async (c) => {
  const p = projects.get(c.req.param('id'))
  if (!p) return c.json({ error: '项目不存在' }, 404)
  const clip = p.clips.find((x) => x.id === c.req.param('clipId'))
  if (!clip) return c.json({ error: '片段不存在' }, 404)
  const { absoluteTimeMs } = await c.req.json<{ absoluteTimeMs: number }>()
  const t = Math.max(0, Math.min(p.duration - 100, absoluteTimeMs))
  const name = `${clip.id}_cover_${Math.round(t)}.jpg`
  const out = join(UPLOAD_DIR, 'frames', name)
  const ok = await grabFrame(join(UPLOAD_DIR, p.fileName), t, out, 1080, 1920)
  if (!ok) return c.json({ error: '抽帧失败，请换个时间点' }, 500)
  const url = `/files/uploads/frames/${name}`
  const edited=editClip(p.id,clip.id,{type:'frame',cover:{source:'frame',frameTime:t,imageUrl:url}})
  return c.json({ cover: edited.cover, clip:edited, url })
})

// ---------- 导出 ----------
app.get('/api/projects/:id/exports', (c) =>
  c.json(exports_.all().filter((e) => {const p=projects.get(c.req.param('id'));return e.projectId===c.req.param('id')&&(!p?.activeClipIds||p.activeClipIds.includes(e.clipId))}).sort((a,b)=>a.createdAt-b.createdAt))
)

app.get('/api/exports', (c) => c.json([...exports_.all()].sort((a, b) => b.createdAt - a.createdAt)))

app.post('/api/projects/:id/export', async (c) => {
  const p = projects.get(c.req.param('id'))
  if (!p) return c.json({ error: '项目不存在' }, 404)
  const body = await c.req.json<{
    clipIds: string[]
    ratio: string
    resolution: string
    withSubtitles: boolean
    exportCover: boolean
    preview?:boolean
  }>()
  if (!body.clipIds?.length) return c.json({ error: '请选择要导出的片段' }, 400)
  if(p.activeClipIds&&body.clipIds.some(id=>!p.activeClipIds!.includes(id)))return c.json({error:'只能导出本次选中的片段'},400)
  const tpl = templateFor(p)
  if (!tpl) return c.json({ error: '项目模板已丢失，请回到第 1 步重新选择' }, 400)
  if(!p.brand?.confirmedAt)return c.json({error:'请在品牌页确认本任务的频道及封面、正文包框'},400)
  if(!['9:16','16:9','1:1','4:5','fit'].includes(body.ratio)||!['720P','1080P','1440P'].includes(body.resolution))return c.json({error:'导出画幅或分辨率无效'},400)

  for(const id of body.clipIds){
    const stored=p.clips.find(c=>c.id===id);if(!stored)return c.json({error:'片段不存在'},404)
    const clip=viewClip(p,stored)
    if(clip.packaging&&clip.subtitleMode!=='en'){
      const active=clip.editPlan!.sourceSubtitles.filter(c=>c.text.trim()&&clip.editPlan!.spans.some(s=>c.start<s.sourceOut&&c.end>s.sourceIn))
      if(active.some(c=>!clip.packaging!.sourceCues.some(t=>t.id===c.id&&t.original===c.text)))return c.json({error:'当前剪辑区间的中文字幕缺失或原文已变更，请重新生成中文包装'},400)
      if(!body.preview&&packagingNeedsReview(clip.packaging,clip.editPlan))return c.json({error:'有中文字幕疑点未核对，请在字幕面板确认后导出'},400)
    }else if(clip.subtitleMode!=='en'&&clip.subtitles.some(c=>isForeign(c.text)))return c.json({error:'请先生成中文字幕，避免将英文原文烧录到成片'},400)
  }
  const created: ExportJob[] = []
  for (const cid of body.clipIds) {
    const clip = p.clips.find((x) => x.id === cid)
    if (!clip) continue
    const job: ExportJob = {
      id: uid('job_'),
      purpose: body.preview ? 'preview':'export',
      projectId: p.id,
      editRevision:clip.editPlan?.revision||0,
      renderSnapshot:{project:{id:p.id,fileName:p.fileName,duration:p.duration},clip:viewClip(p,clip),template:structuredClone(tpl)},
      clipId: clip.id,
      clipTitle: clip.title,
      status: 'queued',
      progress: 0,
      ratio: body.ratio,
      resolution: body.resolution,
      format: 'mp4',
      withSubtitles: body.withSubtitles,
      exportCover: body.exportCover,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    exports_.put(job)
    created.push(job)
  }
  for (const job of created) void runExport(job.id, body.withSubtitles, body.exportCover)
  return c.json({ jobs: created })
})

app.post('/api/exports/:id/retry', (c) => {
  const job = exports_.get(c.req.param('id'))
  if (!job) return c.json({ error: '任务不存在' }, 404)
  if(job.status!=='failed')return c.json({error:'仅失败任务可以重试'},409)
  if(job.renderSnapshot?.clip.subtitleMode!=='en'&&job.renderSnapshot?.clip.subtitles.some(c=>isForeign(c.text))&&!job.renderSnapshot?.clip.packaging)return c.json({error:'旧任务使用英文字幕，请生成中文包装并创建新的导出任务'},400)
  job.status = 'queued'
  job.progress = 0
  job.message = undefined
  exports_.put(job)
  void runExport(job.id, job.withSubtitles, job.exportCover)
  return c.json(job)
})

const RATIOS: Record<string, { w: number; h: number }> = {
  '9:16': { w: 1080, h: 1920 },
  '16:9': { w: 1920, h: 1080 },
  '1:1': { w: 1080, h: 1080 },
  '4:5': { w: 1080, h: 1350 },
}

const RES: Record<string, number> = { '720P': 720, '1080P': 1080, '1440P': 1440 }

function toSrt(cues: SubtitleCue[]): string {
  const t = (ms: number) => {
    const h = String(Math.floor(ms / 3600000)).padStart(2, '0')
    const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0')
    const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')
    const x = String(ms % 1000).padStart(3, '0')
    return `${h}:${m}:${s},${x}`
  }
  return cues.map((cu, i) => `${i + 1}\n${t(cu.start)} --> ${t(cu.end)}\n${cu.text}\n`).join('\n')
}

let ffmpegOk: boolean | null = null
let renderQueue = Promise.resolve()
const queuedJobs = new Set<string>()
function runExport(jobId:string,withSubtitles:boolean,exportCover:boolean) {
  if(queuedJobs.has(jobId))return
  queuedJobs.add(jobId)
  const token=uid('render_');exports_.patch(jobId,{runToken:token})
  renderQueue=renderQueue.then(()=>performExport(jobId,withSubtitles,exportCover,token)).catch((error)=>{
    if(process.env.DEBUG_RENDER==='1')console.error(error)
    if(exports_.get(jobId)?.runToken===token)exports_.patch(jobId,{status:'failed',message:`渲染失败：${error instanceof Error?error.message:'未知错误'}`,updatedAt:Date.now()})
  }).finally(()=>{queuedJobs.delete(jobId)})
}
async function performExport(jobId: string, withSubtitles: boolean, exportCover: boolean,token:string) {
  const job = exports_.get(jobId)
  if (!job) return
  const stored=projects.get(job.projectId)
  const p=job.renderSnapshot?.project||stored
  const clip=job.renderSnapshot?.clip||(stored?.clips.find(c=>c.id===job.clipId))
  const tpl=job.renderSnapshot?.template||(stored?templateFor(stored):undefined)
  if (!p || !clip || !tpl) {
    exports_.patch(jobId, { status: 'failed', message: '项目/片段/模板数据缺失' })
    return
  }
  if (ffmpegOk === null) ffmpegOk = await ffmpegAvailable()
  if (!ffmpegOk) {
    exports_.patch(jobId, { status: 'failed', message: '服务器未安装 ffmpeg，无法渲染。请安装后重试。' })
    return
  }

  const setP = (patch: Partial<ExportJob>) => {if(exports_.get(jobId)?.runToken===token)exports_.patch(jobId, { ...patch, updatedAt: Date.now() })}

  if(clip.subtitleMode!=='en'&&!clip.packaging&&clip.subtitles.some(c=>isForeign(c.text)))throw new Error('旧版本任务包含英文字幕，请生成中文包装后重新创建导出')

  // 导出前校验时间区间：越界/零长度会让 ffmpeg 越过文件末尾，
  // 产出 317 字节的空文件却仍标记“渲染完成”，必须在渲染前拦住
  const safeStart = Math.max(0, Math.min(clip.start, p.duration))
  const safeEnd = Math.max(0, Math.min(clip.end, p.duration))
  if (!(safeEnd - safeStart >= 200)) {
    setP({
      status: 'failed',
      message: `片段区间无效（${clip.start}ms ~ ${clip.end}ms，原视频 ${p.duration}ms），请回到剪辑页重新裁剪后再导出`,
    })
    return
  }

  setP({ status: 'rendering', progress: 2, message: '准备渲染' })

  const size = job.ratio==='fit'?{w:tpl.canvas.width,h:tpl.canvas.height}:RATIOS[job.ratio] ?? RATIOS['9:16']
  const targetLong = RES[job.resolution] ?? 1080
  const scale = targetLong / Math.min(size.w,size.h)
  const W = Math.round((size.w * scale) / 2) * 2
  const H = Math.round((size.h * scale) / 2) * 2

  // 按比例换算模板中的视频区
  const sx = W / tpl.canvas.width
  const sy = H / tpl.canvas.height
  const tr = clip.transform ?? tpl.defaultTransform
  const vp=clip.packaging?.frameLayout?.bodyViewport??tpl.videoViewport
  const viewport = {x:Math.round(vp.x*sx),y:Math.round(vp.y*sy),width:Math.max(2,Math.round(vp.width*sx/2)*2),height:Math.max(2,Math.round(vp.height*sy/2)*2)}

  const outName = `${job.id}_${token}_${safeName(clip.title).slice(0, 24)}.mp4`
  const outPath = join(OUTPUT_DIR, outName)

  // 字幕：生成 srt（随成片一起提供）+ 逐条透明 PNG 用于烧录
  let srtPath: string | null = null
  const subtitlePngs: { pngPath: string; startMs: number; endMs: number }[] = []
  const captions=outputSubtitles(clip)
  if (withSubtitles && captions.length) {
    srtPath = join(OUTPUT_DIR, `${job.id}_${token}.srt`)
    writeFileSync(srtPath, toSrt(captions.map(c=>({...c,text:c.english?c.text+'\n'+c.english:c.text}))))
    for (const cu of captions) {
      const pngPath = join(OUTPUT_DIR, `${job.id}_${token}_sub_${cu.id}.png`)
      if(cu.text.trim()){
        const style=clip.packaging?subtitleStyleFor(clip.packaging):{...defaultTextStyle(48),y:tpl.subtitleSafeArea.y/tpl.canvas.height,width:tpl.subtitleSafeArea.width/tpl.canvas.width}
        await renderSubtitlePng(cu.text,cu.english,W,H,pngPath,style,tpl.canvas.width,'highlights' in cu?cu.highlights as string[]:[])
        subtitlePngs.push({pngPath,startMs:cu.start,endMs:cu.end})
      }
    }
  }

  // 包框图（转为本地绝对路径）
  const bodyFrameLocal = tpl.bodyFrameUrl ? join(UPLOAD_DIR, 'frames', tpl.bodyFrameUrl.split('/').pop()!) : null
  const coverLocal = clip.cover?.imageUrl ? join(UPLOAD_DIR, 'frames', clip.cover.imageUrl.split('/').pop()!) : null

  const replacements = clip.replacements.map((r) => ({
    startMs: r.start, endMs: r.end,
    file: join(UPLOAD_DIR, 'frames', r.assetUrl.split('/').pop()!),
    keepAudio: r.keepAudio, assetIn:r.assetIn,
  }))
  if(replacements.some(r=>!existsSync(r.file)))throw new Error('替换素材文件缺失，请重新上传或撤销替换')

  const bodyTitlePath=join(OUTPUT_DIR,`${job.id}_${token}_body_title.png`)
  if(clip.packaging?.bodyTitle&&clip.packaging.bodyMode!=='off')renderTitlePng(clip.packaging.bodyTitle,W,H,bodyTitlePath,clip.packaging.bodyStyle,tpl.canvas.width)
  const titlePath=join(OUTPUT_DIR,`${job.id}_${token}_title.png`)
  if(clip.cover && (clip.cover.firstScreenDuration || exportCover || clip.packaging))renderTitlePng(clip.packaging?.coverTitle??clip.cover.title,W,H,titlePath,clip.packaging?.coverStyle??clip.cover.titleStyle,tpl.canvas.width)
  const coverFrameLocal=tpl.coverFrameUrl?join(UPLOAD_DIR,'frames',tpl.coverFrameUrl.split('/').pop()!):null
  for(const file of [bodyFrameLocal,coverFrameLocal,coverLocal])if(file&&!existsSync(file))throw new Error('品牌或封面素材文件缺失，请重新上传')
  const composedCover=join(OUTPUT_DIR,`${job.id}_${token}_composed_cover.jpg`)
  const cv=clip.packaging?.frameLayout?.coverViewport
  const coverViewport=cv?{x:cv.x*sx,y:cv.y*sy,width:cv.width*sx,height:cv.height*sy}:undefined
  if(coverLocal&&existsSync(titlePath))await composeCover(coverLocal,titlePath,coverFrameLocal,composedCover,W,H,coverViewport,clip.packaging?.frameLayout?.fit)
  const result = await renderClip({
    input: join(UPLOAD_DIR, p.fileName),
    output: outPath,
    startMs: safeStart,
    endMs: safeEnd,
    canvasW: W,
    canvasH: H,
    viewport,
    bgm:resolveBgm(clip.packaging?.bgm,clipDuration(clip)),
    fit:clip.packaging?.frameLayout?.fit,
    spans: clip.editPlan?.spans,
    transform: {scale:tr.scale ?? 1,offsetX:(tr.offsetX ?? 0)*sx,offsetY:(tr.offsetY ?? 0)*sy},
    subtitlePngs,
    coverImage: coverLocal && (clip.packaging || clip.cover?.firstScreenDuration) ? (existsSync(composedCover)?composedCover:coverLocal) : null,
    firstScreenMs: clip.packaging ? Math.max(1000 / 30, clip.cover?.firstScreenDuration ?? 0) : clip.cover?.firstScreenDuration ?? 0,
    framePng: bodyFrameLocal && existsSync(bodyFrameLocal) ? bodyFrameLocal : null,
    coverFramePng:existsSync(composedCover)?null:coverFrameLocal,
    titlePng:existsSync(composedCover)?null:existsSync(titlePath)?titlePath:null,
    bodyTitlePng:existsSync(bodyTitlePath)?bodyTitlePath:null,
    bodyTitleStartMs:clip.packaging?.titleRange?.start,
    bodyTitleEndMs:clip.packaging?.titleRange?.end??(clip.packaging?.bodyMode==='intro'?clip.packaging.bodyIntroMs:undefined),
    replacements,
    onProgress: (pr) => setP({ progress: Math.max(2, pr),message:`渲染中 ${pr}%` }),
  })

  if (!result.ok) {
    setP({ status: 'failed', message: `渲染失败：${result.message.slice(-1200)}` })
    return
  }

  // ffmpeg 返回 0 也可能产出空文件（例如输入时间区间超出素材），
  // 必须用 ffprobe 确认成片真的有时长，否则不能报“渲染完成”
  const outInfo = await probe(outPath)
  const inputInfo=await probe(join(UPLOAD_DIR,p.fileName))
  if (!outInfo.hasVideo || (inputInfo.hasAudio&&!outInfo.hasAudio) || !outInfo.duration || outInfo.duration < 200 || Math.abs(outInfo.duration-(clip.editPlan?.durationMs ?? safeEnd-safeStart))>200) {
    try { if (existsSync(outPath)) unlinkSync(outPath) } catch {}
    setP({
      status: 'failed',
      message: `渲染产物为空（0 时长）。通常是片段区间超出原视频范围（当前 ${(safeStart / 1000).toFixed(1)}s ~ ${(safeEnd / 1000).toFixed(1)}s），请重新裁剪。`,
    })
    return
  }

  let coverUrl: string | undefined
  if (exportCover) {
    const cn = `${job.id}_${token}_cover.jpg`
    const coverOutput=join(OUTPUT_DIR,cn)
    const background=coverLocal??join(OUTPUT_DIR,`${job.id}_${token}_cover_source.jpg`)
    if(!coverLocal&&!await grabFrame(join(UPLOAD_DIR,p.fileName),clip.cover?.frameTime??safeStart,background,W,H))throw new Error('封面抽帧失败')
    if(!existsSync(titlePath))renderTitlePng(clip.packaging?.coverTitle??clip.title,W,H,titlePath,clip.packaging?.coverStyle??{fontSize:64,color:'#FFFFFF',weight:700,x:.5,y:.18,align:'center'},tpl.canvas.width)
    await composeCover(background,titlePath,coverFrameLocal,coverOutput,W,H,coverViewport,clip.packaging?.frameLayout?.fit)
    coverUrl=outUrl(cn)
  }
  setP({ status: 'completed', progress: 100, fileUrl: outUrl(outName), coverUrl, message: '渲染完成' })
}

/** 打包下载 zip（使用系统 zip 命令） */
app.get('/api/exports/download-all', async (c) => {
  const ids = (c.req.query('ids') ?? '').split(',').filter(Boolean)
  const jobs = exports_.all().filter((j) => (ids.length ? ids.includes(j.id) : true) && j.status === 'completed' && j.fileUrl)
  if (!jobs.length) return c.json({ error: '没有已完成的导出' }, 400)
  const dir = join(OUTPUT_DIR, `zip_${Date.now()}`)
  const { mkdirSync, copyFileSync } = await import('node:fs')
  mkdirSync(dir, { recursive: true })
  for (const j of jobs) {
    const f = join(OUTPUT_DIR, j.fileUrl!.split('/').pop()!)
    if (existsSync(f)) copyFileSync(f, join(dir, j.fileUrl!.split('/').pop()!))
  }
  const zipName = `ai-clip-export-${Date.now()}.zip`
  const zipPath = join(OUTPUT_DIR, zipName)
  const { spawn } = await import('node:child_process')
  // 用 zip 在目标目录内打包，排除 macOS 资源分叉
  const ok = await new Promise<boolean>((resolve) => {
    const p = spawn(
      'zip',
      ['-r', '-X', '-j', zipPath, ...jobs.map((j) => j.fileUrl!.split('/').pop()!)],
      { cwd: OUTPUT_DIR, stdio: 'ignore' }
    )
    p.on('close', (code) => resolve(code === 0))
    p.on('error', () => resolve(false))
  })
  if (!ok || !existsSync(zipPath)) return c.json({ error: '打包失败，请逐个下载' }, 500)
  return c.json({ url: outUrl(zipName) })
})

// ---------- 库表汇总（工作台） ----------
app.get('/api/workbench', (c) => {
  const ps = projects.all()
  return c.json({
    projects: ps.filter((p) => p.analysis.stage !== 'completed').length,
    clips: ps.reduce((n, p) => n + p.clips.length, 0),
    exports: exports_.all().filter((e) => e.status === 'completed' && e.purpose!=='preview').length,
    templates: templates.all().length,
    recent: [...ps].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 6),
  })
})

// 重启后恢复排队项；在途 FFmpeg 明确中断，旧回调不能覆盖新任务状态。
for(const job of exports_.all()){
  if(job.status==='rendering')exports_.patch(job.id,{status:'failed',runToken:uid('interrupted_'),message:'服务重启使渲染中断，请重试',updatedAt:Date.now()})
  else if(job.status==='queued')runExport(job.id,job.withSubtitles,job.exportCover)
}

recoverPackaging()
for(const p of projects.all())if(p.autoFrameRun&&['preparing','rendering'].includes(p.autoFrameRun.status))projects.patch(p.id,{autoFrameRun:{...p.autoFrameRun,status:'failed',message:'服务重启中断自动套框，请重试；已完成包装保留'}})

// Serve the production frontend with the API and uploaded media on one origin.
const frontendDir = join(import.meta.dir, '../../web/dist')
app.get('*', async (c, next) => {
  if (c.req.path.startsWith('/api/') || c.req.path.startsWith('/files/')) return next()
  const path = decodeURIComponent(c.req.path)
  if (path.split('/').includes('..')) return c.notFound()
  const asset = Bun.file(join(frontendDir, path))
  if (await asset.exists()) return new Response(asset)
  const index = Bun.file(join(frontendDir, 'index.html'))
  return await index.exists() ? new Response(index) : c.notFound()
})

// 默认 8788：避开 8787（该端口常被同机其他服务占用，会静默抢走请求）
const port = Number(process.env.PORT || 8788)
console.log(`API on http://localhost:${port}  (ai=${aiMode()})`)
export default {
  port,
  fetch: app.fetch,
  // 视频上传需要更大的请求体上限（默认仅 128MB）
  maxRequestBodySize: 3 * 1024 ** 3,
}
