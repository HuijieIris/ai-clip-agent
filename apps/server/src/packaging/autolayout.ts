import {titleLines} from '../../../../packages/shared/title-layout'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import type { Packaging, TextStyle } from '../../../../packages/shared/packaging'
import type { FrameTemplate } from '../types'
import { UPLOAD_DIR } from '../store'
import { textFont } from '../subtitles'
type Rect = { x: number; y: number; width: number; height: number }
/** 检查现有透明包框的封闭透明窗口；不能识别时保留配置区域。不会修改品牌图。 */
export async function frameWindow(url: string | null, W: number, H: number, fallback: Rect): Promise<Rect> {
  if (!url) return fallback
  const path = join(UPLOAD_DIR, 'frames', url.split('/').pop()!)
  if (!existsSync(path)) throw Error('品牌包框文件缺失')
  const w = Math.round(W / 4),
    h = Math.round(H / 4),
    canvas = createCanvas(w, h),
    ctx = canvas.getContext('2d')
  ctx.drawImage(await loadImage(path), 0, 0, w, h)
  const pixels = ctx.getImageData(0, 0, w, h).data,
    visited = new Uint8Array(w * h)
  let best: Rect | undefined,
    bestArea = 0
  for (let i = 0; i < w * h; i++) {
    if (visited[i] || pixels[i * 4 + 3] > 40) continue
    const stack = [i]
    visited[i] = 1
    let minX = w,
      minY = h,
      maxX = 0,
      maxY = 0,
      area = 0,
      edge = false
    while (stack.length) {
      const n = stack.pop()!,
        x = n % w,
        y = Math.floor(n / w)
      area++
      minX = Math.min(minX, x)
      maxX = Math.max(maxX, x)
      minY = Math.min(minY, y)
      maxY = Math.max(maxY, y)
      if (!x || !y || x === w - 1 || y === h - 1) edge = true
      for (const next of [x ? n - 1 : -1, x < w - 1 ? n + 1 : -1, y ? n - w : -1, y < h - 1 ? n + w : -1])
        if (next >= 0 && !visited[next] && pixels[next * 4 + 3] <= 40) {
          visited[next] = 1
          stack.push(next)
        }
    }
    if (!edge && area > bestArea && area > w * h * 0.08) {
      bestArea = area
      best = {
        x: Math.round((minX / w) * W),
        y: Math.round((minY / h) * H),
        width: Math.round(((maxX - minX + 1) / w) * W),
        height: Math.round(((maxY - minY + 1) / h) * H),
      }
    }
  }
  return best ?? fallback
}
function fitTitle(text: string, style: TextStyle, W: number, H: number, maxHeight: number) {
  const ctx = createCanvas(1, 1).getContext('2d')
  for (let size = style.fontSize; size >= Math.max(8, Math.round((W * 24) / 1080)); size -= 2) {
    ctx.font = `${style.weight} ${size}px "${textFont(style.font)}"`
    const count=titleLines(text,style.width*W,line=>ctx.measureText(line).width).length
    if (
      count <= 3 &&
      count * size * style.lineHeight <= maxHeight &&
      style.y * H + count * size * style.lineHeight <= H
    ) {
      style.fontSize = size
      return
    }
  }
  throw Error('标题过长，无法放入模板标题区，请缩短标题')
}
export async function applyAutoLayout(p: Packaging, tpl: FrameTemplate) {
  const W = tpl.canvas.width,
    H = tpl.canvas.height
  const cover=p.frameLayout?.coverViewport??{x:Math.round(W*.047),y:Math.round(H*.251),width:Math.round(W*.906),height:Math.round(H*.351)}
  const body=tpl.videoViewport
  if (
    !p.frameLayout ||
    p.frameLayout.templateId !== tpl.id ||
    p.frameLayout.templateVersion !== (tpl.version ?? 1)||p.newsLayoutVersion!==1
  ) {
    p.frameLayout = {
      fit: 'cover',
      coverViewport: cover,
      bodyViewport: body,
      templateId: tpl.id,
      templateVersion: tpl.version ?? 1,
    }
    p.coverStyle = {
      ...p.coverStyle,
      fontSize: Math.round((W * 64) / 1080),
      x: 0.5,
      y: Math.min(0.86, (cover.y + cover.height + H * 0.09) / H),
      width: 0.84,
      align: 'center',
      lineHeight: 1.25,
      background: false,
    }
    p.bodyStyle = {
      ...p.bodyStyle,
      fontSize: Math.round((W * 60) / 1080),
      x: (body.x + body.width / 2) / W,
      y:0.145,
      width: (body.width / W) * 0.9,
      align: 'center',
      lineHeight: 1.35,
      background: false,
    }
    // 成片采用新闻模板字幕，编辑器的小字幕保持不变。
    p.finalSubtitleStyle={...p.subtitleStyle,fontSize:Math.round(W*56/1080),x:.5,y:.62,width:.86,lineHeight:1.35,align:'center',background:false,outline:true,outlineWidth:15}
    p.newsLayoutVersion=1
    p.subtitleLayoutVersion = 2
  }
  if(p.frameLayout){p.frameLayout.fit='cover';p.frameLayout.bodyViewport={...tpl.videoViewport}}
  p.coverStyle.font=p.bodyStyle.font='shuhei'
  p.coverStyle.outlineWidth ??= 8
  p.bodyStyle.outlineWidth ??= 8
  p.bodyStyle.outline = true
  p.subtitleStyle.font='sans'
  if(p.finalSubtitleStyle)p.finalSubtitleStyle.font='sans'
  fitTitle(p.coverTitle, p.coverStyle, W, H, Math.max(H * 0.13, H - p.coverStyle.y * H - H * 0.15))
  fitTitle(p.bodyTitle, p.bodyStyle, W, H, H * 0.16)
  return p
}
