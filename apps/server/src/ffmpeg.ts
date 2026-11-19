import {subtitleTrack} from './subtitle-track'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

export interface ProbeResult {
  duration: number // ms
  width: number
  height: number
  hasAudio: boolean
  hasVideo: boolean
  fps: number
}

export function run(cmd: string, args: string[], timeoutMs = 300_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs)
    p.stdout.on('data', (d) => (stdout += d.toString()))
    p.stderr.on('data', (d) => (stderr += d.toString()))
    p.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
    p.on('error', () => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: stderr + '\n(ffmpeg not found)' })
    })
  })
}

export function ffmpegAvailable(): Promise<boolean> {
  return run('ffprobe', ['-version'], 5000).then((r) => r.code === 0)
}

export async function probe(file: string): Promise<ProbeResult> {
  const r = await run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration:stream=codec_type,width,height,r_frame_rate',
    '-of', 'json',
    file,
  ], 30_000)
  let duration = 0
  let width = 0
  let height = 0
  let hasAudio = false
  let hasVideo = false
  let fps = 30
  try {
    const j = JSON.parse(r.stdout)
    duration = Math.round(parseFloat(j.format?.duration ?? '0') * 1000)
    for (const s of j.streams ?? []) {
      if (s.codec_type === 'audio') hasAudio = true
      if (s.codec_type === 'video') {
        hasVideo = true
        width = s.width ?? 0
        height = s.height ?? 0
        if (s.r_frame_rate?.includes('/')) {
          const [a, b] = s.r_frame_rate.split('/').map(Number)
          if (b) fps = a / b
        }
      }
    }
  } catch {}
  return { duration, width, height, hasAudio, hasVideo, fps }
}

/**
 * 抽取音轨为 wav，供转写使用。
 *
 * filter 用于可选的音频预处理。嘈杂的发布会 / 访谈录音可以先做降噪与响度归一化，
 * 对识别率有明显帮助，但也可能把本来就不错的音频改坏，所以默认不开。
 * 用法：ASR_AUDIO_FILTER="highpass=f=80,dynaudnorm=f=250"
 */
export async function extractAudio(input: string, output: string, filter?: string): Promise<boolean> {
  const args = ['-y', '-i', input, '-vn', '-ac', '1', '-ar', '16000']
  if (filter && filter.trim()) args.push('-af', filter.trim())
  args.push(output)
  const r = await run('ffmpeg', args, 600_000)
  return r.code === 0
}

/**
 * 按时间区间切出一段音频（供长音频分片送 ASR）。
 * 统一转换成 16k 单声道 PCM wav，保证每次送出的格式一致。
 */
export async function sliceAudio(
  input: string,
  output: string,
  startSec: number,
  durationSec: number
): Promise<boolean> {
  const r = await run('ffmpeg', [
    '-y',
    '-ss', String(Math.max(0, startSec)),
    '-t', String(Math.max(0.1, durationSec)),
    '-i', input,
    '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
    output,
  ], 300_000)
  return r.code === 0
}

/** 按时间点截取一帧生成封面 */
export async function grabFrame(input: string, timeMs: number, output: string, width = 1080, height = 1920): Promise<boolean> {
  const t = Math.max(0, timeMs) / 1000
  const r = await run('ffmpeg', [
    '-y', '-ss', String(t), '-i', input, '-frames:v', '1',
    '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
    output,
  ], 60_000)
  return r.code === 0
}

export interface RenderOptions {
  input: string
  output: string
  startMs: number
  endMs: number
  spans?: { sourceIn: number; sourceOut: number }[]
  transform?: { scale: number; offsetX: number; offsetY: number }
  canvasW: number
  canvasH: number
  /** 视频在画布上的目标区域（像素） */
  viewport: { x: number; y: number; width: number; height: number }
  /** 每条字幕的透明 PNG 与显示区间（片内相对毫秒） */
  subtitlePngs?: { pngPath: string; startMs: number; endMs: number }[]
  coverImage?: string | null
  firstScreenMs?: number
  framePng?: string | null
  coverFramePng?:string|null
  titlePng?:string|null
  bodyTitlePng?:string|null
  bodyTitleStartMs?:number
  bodyTitleEndMs?:number
  bgm?: import("../../../packages/shared/music").BgmSettings & {file:string}
  fit?:"contain"|"cover"
  replacements?: { startMs: number; endMs: number; file: string; keepAudio: boolean; assetIn?: number }[]
  onProgress?: (p: number) => void
}

/**
 * 真实 ffmpeg 渲染：裁切时间段 → 缩放适配包框内视频区 → 叠加包框图 → 烧字幕 → 首屏封面
 */
export async function renderClip(opts: RenderOptions): Promise<{ ok: boolean; message: string }> {
  const { input, output, startMs, endMs } = opts
  const spans = opts.spans?.length ? opts.spans : [{sourceIn:startMs,sourceOut:endMs}]
  const durSec = spans.reduce((n,s)=>n+s.sourceOut-s.sourceIn,0)/1000
  const sourceStart = spans[0].sourceIn
  const sourceDuration = (spans[spans.length-1].sourceOut-sourceStart)/1000
  const info = await probe(input)
  if (!info.hasVideo || durSec <= 0) return {ok:false,message:'无效视频或保留区间'}
  const { canvasW: W, canvasH: H, viewport: rawViewport } = opts
  const vp=opts.fit==='contain'?{...rawViewport,width:Math.max(2,Math.floor(rawViewport.width/2)*2),height:Math.max(2,Math.floor(rawViewport.height/2)*2)}:rawViewport

  const args: string[] = ['-y', '-ss', String(sourceStart / 1000), '-t', String(sourceDuration), '-i', input]

  let layerInputIndex = 1
  const extraInputs: string[] = []
  let frameIdx: number | null = null
  let coverIdx: number | null = null
  let coverFrameIdx:number|null=null,titleIdx:number|null=null,bodyTitleIdx:number|null=null
  if(opts.bodyTitlePng){extraInputs.push("-loop","1","-framerate","1","-t",String(durSec),"-i",opts.bodyTitlePng);bodyTitleIdx=layerInputIndex++}
  for(const [kind,path] of [["frame",opts.coverFramePng],["title",opts.titlePng]])if(path){extraInputs.push("-loop","1","-framerate","1","-t",String(durSec),"-i",path);if(kind==="frame")coverFrameIdx=layerInputIndex++;else titleIdx=layerInputIndex++}

  if (opts.framePng) {
    extraInputs.push('-loop', '1', '-framerate','1', '-t', String(durSec), '-i', opts.framePng)
    frameIdx = layerInputIndex++
  }
  if (opts.coverImage && (opts.firstScreenMs ?? 0) > 0) {
    extraInputs.push('-loop', '1', '-framerate','1', '-t', String(durSec), '-i', opts.coverImage)
    coverIdx = layerInputIndex++
  }
  const track=subtitleTrack(opts.subtitlePngs??[],durSec*1000,W,H,output)
  let subtitleTrackIndex:number|null=null
  if(track){extraInputs.push('-f','concat','-safe','0','-i',track);subtitleTrackIndex=layerInputIndex++}
  // 字幕以透明 PNG 逐条 overlay，避免依赖 libass/drawtext
  const subPngs: { idx: number; startMs: number; endMs: number }[] = []
  for (const sp of track?[]:opts.subtitlePngs ?? []) {
    if (!existsSync(sp.pngPath)) continue
    extraInputs.push('-loop', '1', '-framerate','1', '-t', String(durSec), '-i', sp.pngPath)
    subPngs.push({ idx: layerInputIndex++, startMs: sp.startMs, endMs: sp.endMs })
  }
  // 画面替换素材（图片或视频）
  const replIdx: { idx: number; startMs: number; endMs: number }[] = []
  for (const r of opts.replacements ?? []) {
    const isImg = /\.(png|jpe?g|webp|bmp)$/i.test(r.file)
    if (isImg) extraInputs.push('-loop', '1', '-framerate','1', '-t', String(durSec), '-i', r.file)
    else extraInputs.push('-stream_loop', '-1', '-ss', String((r.assetIn ?? 0)/1000), '-t', String(durSec), '-i', r.file)
    replIdx.push({ idx: layerInputIndex++, startMs: r.startMs, endMs: r.endMs })
  }

  let bgmIndex:number|null=null
  if(opts.bgm?.enabled){bgmIndex=layerInputIndex++;extraInputs.push('-stream_loop','-1','-i',opts.bgm.file)}
  args.push(...extraInputs)

  const filters: string[] = []
  // 同一组源区间同步裁切音频和视频，再生成成片时间轴。
  filters.push(`[0:v]split=${spans.length}${spans.map((_,i)=>`[sv${i}]`).join('')}`)
  if(info.hasAudio) filters.push(`[0:a]asplit=${spans.length}${spans.map((_,i)=>`[sa${i}]`).join('')}`)
  spans.forEach((s,i)=>{
    const a=(s.sourceIn-sourceStart)/1000,b=(s.sourceOut-sourceStart)/1000
    filters.push(`[sv${i}]trim=start=${a}:end=${b},setpts=PTS-STARTPTS[v${i}]`)
    if(info.hasAudio)filters.push(`[sa${i}]atrim=start=${a}:end=${b},asetpts=PTS-STARTPTS[a${i}]`)
  })
  filters.push(`${spans.map((_,i)=>`[v${i}]${info.hasAudio?`[a${i}]`:''}`).join('')}concat=n=${spans.length}:v=1:a=${info.hasAudio?1:0}[joined]${info.hasAudio?'[audio]':''}`)
  const tr=opts.transform??{scale:1,offsetX:0,offsetY:0}
  const zw=Math.max(2,Math.round(vp.width*tr.scale/2)*2),zh=Math.max(2,Math.round(vp.height*tr.scale/2)*2)
  const fit=opts.fit==='contain'?`scale=${vp.width}:${vp.height}:force_original_aspect_ratio=decrease,format=yuva420p,pad=${vp.width}:${vp.height}:(ow-iw)/2:(oh-ih)/2:color=black@0`:`scale=${vp.width}:${vp.height}:force_original_aspect_ratio=increase,crop=${vp.width}:${vp.height}`
  filters.push(`[joined]split=2[foreground][background]`)
  filters.push(`[background]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=20:2,setsar=1,fps=30[backdrop]`)
  filters.push(`[foreground]${fit},scale=${zw}:${zh},setsar=1,fps=30[subject]`)
  filters.push(`color=c=black@0:s=${vp.width}x${vp.height}:r=30:d=${durSec},format=yuva420p[window]`)
  filters.push(`[window][subject]overlay=x=${(vp.width-zw)/2+tr.offsetX}:y=${(vp.height-zh)/2+tr.offsetY}:shortest=1:format=auto[base]`)
  let current = '[base]'

  // 2. 画面替换：素材输入已被 -t 限制为整段时长，用 enable 控制可见区间
  replIdx.forEach((r, i) => {
    const relStart = Math.max(0, r.startMs / 1000)
    const relEnd = Math.min(durSec, r.endMs / 1000)
    if (relEnd <= relStart) return
    const label = `[rv${i}]`
    filters.push(
      `[${r.idx}:v]${fit},setsar=1,fps=30,setpts=PTS-STARTPTS+${relStart}/TB${label}`
    )
    const out = `[mix${i}]`
    filters.push(
      `${current}${label}overlay=enable='between(t,${relStart},${relEnd})':x=0:y=0:eof_action=repeat:shortest=0${out}`
    )
    current = out
  })

  // 3. 放到画布上
  filters.push(`[backdrop]${current}overlay=${vp.x}:${vp.y}:shortest=1[canvas]`)
  current = '[canvas]'

  // 6. 包框图（透明 PNG/SVG 转 PNG）
  if (frameIdx !== null) {
    filters.push(`[${frameIdx}:v]scale=${W}:${H},format=rgba[frameimg]`)
    filters.push(`${current}[frameimg]overlay=0:0:format=auto:enable='gte(t,${coverIdx!==null?(opts.firstScreenMs??0)/1000:0})'[outv]`)
    current = '[outv]'
  }


  if(subtitleTrackIndex!==null){filters.push(`[${subtitleTrackIndex}:v]scale=${W}:${H},format=rgba[subtitletrack]`);filters.push(`${current}[subtitletrack]overlay=0:0:eof_action=repeat:shortest=0[trackedsub]`);current='[trackedsub]'}
  // 4. 字幕叠加（逐条 enable 区间控制）
  subPngs.forEach((sp, i) => {
    const s0 = Math.max(0, (sp.startMs) / 1000)
    const s1 = Math.min(durSec, (sp.endMs) / 1000)
    if (s1 <= s0) return
    filters.push(`[${sp.idx}:v]scale=${W}:${H},format=rgba[sub${i}]`)
    const out = `[withsub${i}]`
    filters.push(`${current}[sub${i}]overlay=0:0:format=auto:enable='gte(t,${s0})*lt(t,${s1})'${out}`)
    current = out
  })

  if(bodyTitleIdx!==null){filters.push(`[${bodyTitleIdx}:v]scale=${W}:${H},format=rgba[bodytitle]`);filters.push(`${current}[bodytitle]overlay=0:0:enable='gte(t,${(opts.bodyTitleStartMs??0)/1000})*lt(t,${(opts.bodyTitleEndMs??durSec*1000)/1000})'[withbodytitle]`);current='[withbodytitle]'}
  // 5. 首屏封面
  if (coverIdx !== null && (opts.firstScreenMs ?? 0) > 0) {
    const d = (opts.firstScreenMs ?? 0) / 1000
    filters.push(`[${coverIdx}:v]scale=${W}:${H},setsar=1[coverimg]`)
    filters.push(`${current}[coverimg]overlay=0:0:enable='lt(t,${d})'[withcover]`)
    current = '[withcover]'
  }

  if(coverIdx!==null){
    for(const [kind,idx] of [['cframe',coverFrameIdx],['ctitle',titleIdx]] as const)if(idx!==null){
      filters.push(`[${idx}:v]scale=${W}:${H},format=rgba[${kind}]`)
      filters.push(`${current}[${kind}]overlay=0:0:enable='lt(t,${(opts.firstScreenMs??0)/1000})'[with${kind}]`);current=`[with${kind}]`
    }
  }
  filters.push(`${current}format=yuv420p[vout]`)

  let audioOut=info.hasAudio?'[audio]':null
  if(opts.bgm?.enabled&&bgmIndex!==null){
    const m=opts.bgm,start=m.start/1000,length=Math.min(durSec,m.end/1000)-start,fadeIn=Math.min(m.fadeIn/1000,length/2),fadeOut=Math.min(m.fadeOut/1000,length/2)
    if(length<=0)return {ok:false,message:'音乐应用范围无效'}
    filters.push(`[${bgmIndex}:a]atrim=start=${m.sourceIn/1000}:duration=${length},asetpts=PTS-STARTPTS,loudnorm=I=-23:TP=-2:LRA=7,volume=${m.volume},afade=t=in:d=${fadeIn},afade=t=out:st=${Math.max(0,length-fadeOut)}:d=${fadeOut},adelay=${Math.round(m.start)}:all=1,apad,atrim=duration=${durSec}[musicbed]`)
    if(info.hasAudio){
      if(m.ducking){filters.push('[audio]asplit=2[dryvoice][sidevoice]');filters.push('[musicbed][sidevoice]sidechaincompress=threshold=0.025:ratio=8:attack=10:release=250[duckedmusic]');filters.push('[dryvoice][duckedmusic]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[mixedaudio]')}
      else filters.push('[audio][musicbed]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[mixedaudio]')
      audioOut='[mixedaudio]'
    }else audioOut='[musicbed]'
  }
  args.push('-filter_complex', filters.join(';'))
  args.push('-map', '[vout]')
  if(audioOut)args.push('-map',audioOut)
  args.push('-t', String(durSec), '-filter_complex_threads', '1')
  args.push('-shortest')
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-movflags', '+faststart', '-c:a', 'aac', '-b:a', '128k')
  args.push('-progress', 'pipe:1', output)

  return new Promise((resolve) => {
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let err = ''
    const timeout=setTimeout(()=>p.kill('SIGKILL'),30*60*1000)
    p.stdout.on('data', (d) => {
      const txt = d.toString()
      const m = txt.match(/out_time_ms=(\d+)/)
      if (m && opts.onProgress) {
        const sec = Number(m[1]) / 1_000_000
        opts.onProgress(Math.min(99, Math.round((sec / durSec) * 100)))
      }
    })
    p.stderr.on('data', (d) => (err += d.toString()))
    p.on('close', (code) => {
      clearTimeout(timeout)
      if (code === 0) resolve({ ok: true, message: 'ok' })
      else resolve({ ok: false, message: err.slice(-1200) })
    })
    p.on('error', (e) => {clearTimeout(timeout);resolve({ ok: false, message: String(e) })})
  })
}
