import {titleLines} from '../../../packages/shared/title-layout'
import {subtitleDisplayText} from '../../../packages/shared/packaging'
import type { TextStyle } from '../../../packages/shared/packaging'
import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas'
import { writeFileSync, existsSync, rmSync,readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

export interface Cue {
  start: number
  end: number
  text: string
}

let fontLoaded = false
function ensureFont() {
  if (fontLoaded) return
  fontLoaded = true
  const candidates = [
    '/System/Library/Fonts/PingFang.ttc',
    '/System/Library/Fonts/STHeiti Medium.ttc',
    '/System/Library/Fonts/Supplemental/Songti.ttc',
    '/System/Library/Fonts/Hiragino Sans GB.ttc',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    'C:/Windows/Fonts/msyh.ttc',
  ]
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        GlobalFonts.registerFromPath(p, 'ClipSub')
        return
      } catch {}
    }
  }
}

export function fontFamily(): string {
  ensureFont()
  return GlobalFonts.has('ClipSub') ? 'ClipSub' : 'sans-serif'
}

/**
 * 渲染一条字幕为透明 PNG（支持自动换行、描边、半透明底条）。
 * 返回 null 表示该句为空、跳过。
 */
export function renderCuePng(
  text: string,
  canvasW: number,
  canvasH: number,
  outPath: string,
  opts?: {
    style?: TextStyle
    sourceW?: number
    highlights?: string[]
    area?: { x: number; y: number; width: number; height: number }
    fontSize?: number
    bottomRatio?: number
    maxWidthRatio?: number
  },
): boolean {
  const clean = text.trim()
  if (!clean) return false
  ensureFont()
  const style = opts?.style
  const fontSize = style
    ? Math.round((style.fontSize * canvasW) / (opts?.sourceW ?? canvasW))
    : (opts?.fontSize ?? Math.round(canvasW / 24))
  const maxWidth = style
    ? Math.round(canvasW * style.width)
    : Math.round(opts?.area ? opts.area.width * 0.9 : canvasW * (opts?.maxWidthRatio ?? 0.86))
  const lineHeight = Math.round(fontSize * (style?.lineHeight ?? 1.45))

  const canvas = createCanvas(canvasW, canvasH)
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, canvasW, canvasH)
  ctx.font = `${style?.weight ?? 600} ${fontSize}px "${textFont(style?.font)}"`
  ctx.textAlign = style?.align ?? 'center'
  ctx.textBaseline = 'middle'

  // 手动换行（中文按字符宽度累加）
  const lines: string[] = []
  let cur = ''
  for (const ch of clean) {
    if (ch === '\n') {
      lines.push(cur)
      cur = ''
      continue
    }
    const test = cur + ch
    if (ctx.measureText(test).width > maxWidth && cur) {
      lines.push(cur)
      cur = ch
    } else {
      cur = test
    }
  }
  if (cur) lines.push(cur)

  for(let i=0;i<lines.length;i++)lines[i]=subtitleDisplayText(lines[i])
  const blockH = lines.length * lineHeight
  const bottom = Math.round(canvasH * (opts?.bottomRatio ?? 0.13))
  const centerY = style
    ? style.y * canvasH + blockH / 2
    : opts?.area
      ? opts.area.y + opts.area.height / 2
      : canvasH - bottom - blockH / 2
  const centerX = style ? style.x * canvasW : opts?.area ? opts.area.x + opts.area.width / 2 : canvasW / 2
  if (
    style &&
    (lines.length > 2 ||
      centerY + blockH / 2 + fontSize * 0.34 > canvasH ||
      centerY - blockH / 2 - fontSize * 0.34 < 0)
  )
    throw new Error('字幕超出两行或画布边界，请调整断句、字号或位置')
  if (!style && opts?.area && blockH + fontSize * 0.68 > opts.area.height)
    throw new Error('字幕超出模板安全区，请缩短字幕或调整模板')

  // 底条
  const widest = Math.max(...lines.map((l) => ctx.measureText(l).width))
  const padX = Math.round(fontSize * 0.5)
  const padY = Math.round(fontSize * 0.34)
  ctx.fillStyle = 'rgba(0,0,0,0.42)'
  const boxX = centerX - (style?.align === 'left' ? 0 : style?.align === 'right' ? widest : widest / 2) - padX
  if (style && (boxX < 0 || boxX + widest + padX * 2 > canvasW))
    throw new Error('字幕超出画布水平边界，请调整位置或宽度')
  const boxY = centerY - blockH / 2 - padY
  const boxW = widest + padX * 2
  const boxH = blockH + padY * 2
  const r = Math.round(fontSize * 0.2)
  ctx.beginPath()
  ctx.moveTo(boxX + r, boxY)
  ctx.arcTo(boxX + boxW, boxY, boxX + boxW, boxY + boxH, r)
  ctx.arcTo(boxX + boxW, boxY + boxH, boxX, boxY + boxH, r)
  ctx.arcTo(boxX, boxY + boxH, boxX, boxY, r)
  ctx.arcTo(boxX, boxY, boxX + boxW, boxY, r)
  ctx.closePath()
  if (style?.background !== false) ctx.fill()

  // 文字 + 描边
  lines.forEach((line, i) => {
    const y = centerY - blockH / 2 + lineHeight / 2 + i * lineHeight
    ctx.lineWidth =
      style?.outlineWidth !== undefined
        ? (style.outlineWidth * canvasW) / 1080
        : Math.max(2, fontSize * 0.09)
    ctx.strokeStyle = '#000000'
    ctx.lineJoin = 'round'
    if (style?.outline !== false) ctx.strokeText(subtitleDisplayText(line), centerX, y)
    ctx.fillStyle = style?.color ?? '#FFFFFF'
    ctx.fillText(subtitleDisplayText(line), centerX, y)
    const highlights = opts?.highlights ?? []
    if (highlights.length) {
      let x =
        centerX -
        ctx.measureText(line).width * (style?.align === 'left' ? 0 : style?.align === 'right' ? 1 : 0.5)
      for (let j = 0; j < line.length; j++) {
        ctx.textAlign = 'left'
        ctx.fillStyle = highlights.some((t) => {
          let at = line.indexOf(t)
          while (at >= 0) {
            if (j >= at && j < at + t.length) return true
            at = line.indexOf(t, at + 1)
          }
          return false
        })
          ? (style?.highlightColor ?? '#C9FF4D')
          : (style?.color ?? '#FFFFFF')
        ctx.fillText(line[j], x, y)
        x += ctx.measureText(line[j]).width
      }
      ctx.textAlign = style?.align ?? 'center'
    }
  })

  writeFileSync(outPath, canvas.toBuffer('image/png'))
  return true
}

/** 组装 ffmpeg 的 overlay 字幕滤镜链：一次输入一张透明图，用 enable 控制显示区间 */
export function buildSubtitleOverlays(
  cues: { pngPath: string; index: number; startMs: number; endMs: number }[],
  canvasW: number,
  canvasH: number,
): { inputs: string[]; filters: string[] } {
  const inputs: string[] = []
  const filters: string[] = []
  for (const c of cues) {
    inputs.push('-loop', '1', '-i', c.pngPath)
  }
  return { inputs, filters }
}

/** 用 canvas 光栅化 SVG（可选渲染），失败返回 null */
export async function rasterizeSvg(svg: string, w: number, h: number): Promise<Buffer | null> {
  try {
    const { loadImage } = await import('@napi-rs/canvas')
    const canvas = createCanvas(w, h)
    const ctx = canvas.getContext('2d')
    const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
    const img = await loadImage(dataUrl)
    ctx.drawImage(img, 0, 0, w, h)
    return canvas.toBuffer('image/png')
  } catch {
    return null
  }
}

export function ffmpegHasFilter(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-filters'], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    p.stdout.on('data', (d) => (out += d.toString()))
    p.on('close', () => resolve(new RegExp(`\\s${name}\\s`).test(out)))
    p.on('error', () => resolve(false))
  })
}

/** 标题层使用保存的画布坐标；预览和导出共用此 PNG。 */
export function renderTitlePng(
  text: string,
  W: number,
  H: number,
  out: string,
  style: {
    fontSize: number
    color: string
    weight: number
    x: number
    y: number
    align: 'left' | 'center' | 'right'
    font?: 'sans' | 'serif' | 'shuhei'
    width?: number
    lineHeight?: number
    outline?: boolean
    outlineWidth?: number
    background?: boolean
  },
  sourceW: number,
) {
  const canvas = createCanvas(W, H),
    ctx = canvas.getContext('2d')
  const fontSize = Math.round((style.fontSize * W) / sourceW)
  ctx.font = `${style.weight} ${fontSize}px "${textFont(style.font)}"`
  ctx.textAlign = style.align
  ctx.textBaseline = 'top'
  ctx.fillStyle = style.color
  ctx.strokeStyle = '#000000'
  ctx.lineJoin = 'round'
  ctx.lineWidth = style.outlineWidth === undefined ? Math.max(2, fontSize * 0.06) : style.outlineWidth * W / sourceW
  const lines=titleLines(text,W*(style.width??.82),line=>ctx.measureText(line).width)
  if (style.y * H + lines.length * fontSize * (style.lineHeight ?? 1.4) > H)
    throw new Error('封面标题超出画布，请调整字号或位置')
  const widest = Math.max(0, ...lines.map((l) => ctx.measureText(l).width)),
    left = style.x * W - widest * (style.align === 'left' ? 0 : style.align === 'right' ? 1 : 0.5)
  if (left < 0 || left + widest > W) throw new Error('标题超出画布水平边界，请调整位置或宽度')
  if (style.background) {
    ctx.fillStyle = 'rgba(0,0,0,.42)'
    ctx.fillRect(
      left - 4,
      style.y * H - 4,
      widest + 8,
      lines.length * fontSize * (style.lineHeight ?? 1.4) + 8,
    )
    ctx.fillStyle = style.color
  }
  lines.forEach((l, i) => {
    const y = style.y * H + i * fontSize * (style.lineHeight ?? 1.4)
    if (style.outline !== false && style.outlineWidth !== 0) ctx.strokeText(l, style.x * W, y)
    ctx.fillText(l, style.x * W, y)
  })
  writeFileSync(out, canvas.toBuffer('image/png'))
}

export async function composeCover(
  background: string,
  title: string,
  frame: string | null,
  out: string,
  W: number,
  H: number,
  viewport?:{x:number;y:number;width:number;height:number},
  fit:"contain"|"cover"="contain",
) {
  const canvas = createCanvas(W, H),ctx = canvas.getContext('2d')
  ctx.fillStyle='#000';ctx.fillRect(0,0,W,H)
  const image=await loadImage(readFileSync(background)),vp=viewport??{x:0,y:0,width:W,height:H},scale=(fit==='cover'?Math.max:Math.min)(vp.width/image.width,vp.height/image.height)
  const bgScale=Math.max(W/image.width,H/image.height)
  ctx.save();ctx.filter=`blur(${Math.max(8, W/40)}px)`;ctx.drawImage(image,(W-image.width*bgScale)/2-W*.05,(H-image.height*bgScale)/2-H*.05,image.width*bgScale+W*.1,image.height*bgScale+H*.1);ctx.restore()
  ctx.save();ctx.beginPath();ctx.rect(vp.x,vp.y,vp.width,vp.height);ctx.clip()
  ctx.drawImage(image,vp.x+(vp.width-image.width*scale)/2,vp.y+(vp.height-image.height*scale)/2,image.width*scale,image.height*scale)
  ctx.restore()
  if (frame) ctx.drawImage(await loadImage(readFileSync(frame)), 0, 0, W, H)
  ctx.drawImage(await loadImage(readFileSync(title)), 0, 0, W, H)
  writeFileSync(out, canvas.toBuffer('image/jpeg'))
}

export function textFont(font: 'sans' | 'serif' | 'shuhei' = 'sans') {
  ensureFont()
  if (font === 'shuhei') {
    if (!GlobalFonts.has('ClipShuhei')) {
      const path = process.env.TITLE_FONT_PATH || join(homedir(), 'Library/Fonts/阿里妈妈数黑体.ttf')
      if (!existsSync(path) || !GlobalFonts.registerFromPath(path, 'ClipShuhei')) throw new Error('未安装阿里妈妈数黑体，请设置 TITLE_FONT_PATH')
    }
    return 'ClipShuhei'
  }
  if (font === 'serif') {
    if (!GlobalFonts.has('ClipSerif'))
      for (const path of [
        '/System/Library/Fonts/Supplemental/Songti.ttc',
        '/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc',
      ])
        if (existsSync(path)) {
          GlobalFonts.registerFromPath(path, 'ClipSerif')
          break
        }
    if (!GlobalFonts.has('ClipSerif')) throw new Error('当前服务器未安装可用中文宋体，请选择黑体')
    return 'ClipSerif'
  }
  return fontFamily()
}
export function availableTextFonts() {
  const list = [{ id: 'sans', name: '系统黑体（macOS 苹方）' }]
  try { textFont('shuhei'); list.push({id:'shuhei',name:'阿里妈妈数黑体'}) } catch {}
  try {
    textFont('serif')
    list.push({ id: 'serif', name: '系统中文宋体' })
  } catch {}
  return list
}

/** 双语同源区间：中文上、英文下。描边按模板画布缩放，无背景及阴影。 */
export async function renderSubtitlePng(
  text: string,
  english: string | undefined,
  W: number,
  H: number,
  out: string,
  style: TextStyle,
  sourceW: number,
  highlights: string[] = [],
) {
  const base = { ...style, background: false, outline: true, outlineWidth: 15 }
  if (!english) {
    renderCuePng(text, W, H, out, { style: base, sourceW, highlights })
    return
  }
  const temp = out + '.' + crypto.randomUUID(),
    zh = temp + '.zh.png',
    en = temp + '.en.png'
  try {
    renderCuePng(text, W, H, zh, { style: base, sourceW, highlights })
    const canvas = createCanvas(W, H),
      ctx = canvas.getContext('2d')
    ctx.drawImage(await loadImage(readFileSync(zh)), 0, 0)
    const englishStyle = {
      ...base,
      fontSize: Math.max(12, Math.round(base.fontSize * 0.72)),
      y: Math.min(0.94, base.y + (base.fontSize * base.lineHeight * 2.2) / ((sourceW * H) / W)),
    }
    for (let size = englishStyle.fontSize; size >= 12; size -= 2) {
      try {
        renderCuePng(english, W, H, en, { style: { ...englishStyle, fontSize: size }, sourceW })
        ctx.drawImage(await loadImage(readFileSync(en)), 0, 0)
        writeFileSync(out, canvas.toBuffer('image/png'))
        return
      } catch (error) {
        if (size <= 13) throw error
      }
    }
  } finally {
    rmSync(zh, { force: true })
    rmSync(en, { force: true })
  }
}
