/**
 * 画面比例定义：前后端共用的唯一来源。
 * 5.8 寸 = 手机屏幕主流规格 1170×2532（iPhone 12/13/14 Pro 逻辑像素），归入竖屏族。
 */
export interface RatioDef {
  id: string
  label: string
  /** 显示用宽高比字符串 */
  ratio: string
  /** 该比例族的标准输出尺寸（长边按分辨率档位缩放） */
  width: number
  height: number
  /** true 表示宽度为主要约束（竖屏），false 表示高度为主要约束（横屏） */
  portrait: boolean
  /** 说明文字 */
  hint?: string
}

export const RATIOS: RatioDef[] = [
  { id: 'fit', label: '适应包框', ratio: 'auto', width: 0, height: 0, portrait: false, hint: '沿用模板画布尺寸' },
  { id: '16:9', label: '16:9', ratio: '16:9', width: 1920, height: 1080, portrait: false, hint: '横屏 · B站/YouTube' },
  { id: '4:3', label: '4:3', ratio: '4:3', width: 1440, height: 1080, portrait: false, hint: '横屏 · 复古/课件' },
  { id: '2.35:1', label: '2.35:1', ratio: '2.35:1', width: 2538, height: 1080, portrait: false, hint: '宽银幕 · 电影感' },
  { id: '2:1', label: '2:1', ratio: '2:1', width: 2160, height: 1080, portrait: false, hint: '超宽 · 影视' },
  { id: '1.85:1', label: '1.85:1', ratio: '1.85:1', width: 1998, height: 1080, portrait: false, hint: '学院宽银幕' },
  { id: '9:16', label: '9:16', ratio: '9:16', width: 1080, height: 1920, portrait: true, hint: '竖屏 · 抖音/快手/视频号' },
  { id: '3:4', label: '3:4', ratio: '3:4', width: 1080, height: 1440, portrait: true, hint: '竖版 · 笔记/小红书' },
  { id: '5.8', label: '5.8 寸', ratio: '1170:2532', width: 1170, height: 2532, portrait: true, hint: '手机屏幕 · 1170×2532' },
  { id: '1:1', label: '1:1', ratio: '1:1', width: 1080, height: 1080, portrait: false, hint: '方形 · 通用' },
  { id: '1:2', label: '1:2', ratio: '1:2', width: 1080, height: 2160, portrait: true, hint: '长图海报' },
]

export function getRatio(id: string): RatioDef {
  return RATIOS.find((r) => r.id === id) ?? RATIOS[0]
}

/** 按分辨率档位计算最终输出尺寸（保持比例，长边对齐档位） */
export function resolveSize(ratioId: string, resolution: string): { w: number; h: number } {
  const def = getRatio(ratioId)
  if (def.id === 'fit') return { w: 1080, h: 1920 }
  const longEdge = resolution === '720P' ? 720 : resolution === '1440P' ? 1440 : 1080
  if (def.portrait) {
    const w = longEdge
    const h = Math.round((longEdge * def.height) / def.width)
    return { w: even(w), h: even(h) }
  }
  const h = longEdge
  const w = Math.round((longEdge * def.width) / def.height)
  return { w: even(w), h: even(h) }
}

function even(n: number) {
  return n % 2 === 0 ? n : n + 1
}

/** 判断模板画布与新比例是否兼容（同族 + 比例误差 < 12%） */
export function checkFrameFit(
  tpl: { canvas: { width: number; height: number } } | null,
  ratioId: string
): { ok: boolean; level: 'ok' | 'warn' | 'error'; message: string } {
  if (!tpl) return { ok: false, level: 'error', message: '尚未选择包框模板' }
  const def = getRatio(ratioId)
  if (def.id === 'fit') return { ok: true, level: 'ok', message: '按模板画布输出，无需调整' }
  const tplRatio = tpl.canvas.width / tpl.canvas.height
  const target = def.width / def.height
  const diff = Math.abs(tplRatio - target) / target
  const tplPortrait = tplRatio < 1
  if (tplPortrait !== def.portrait && diff > 0.02) {
    return {
      ok: false,
      level: 'error',
      message: `包框是${tplPortrait ? '竖屏' : '横屏'}（${tpl.canvas.width}×${tpl.canvas.height}），与 ${def.label} 方向不一致，套用后画面会被拉伸。建议新建该比例的包框模板。`,
    }
  }
  if (diff > 0.12) {
    return {
      ok: false,
      level: 'error',
      message: `包框比例 ${(tplRatio).toFixed(2)}:1 与目标 ${def.label} 差异超过 12%，套用会明显变形。建议新建模板。`,
    }
  }
  if (diff > 0.04) {
    return {
      ok: true,
      level: 'warn',
      message: `包框比例与 ${def.label} 有 ${(diff * 100).toFixed(0)}% 差异，导出时会等比缩放并以黑边补齐。`,
    }
  }
  return { ok: true, level: 'ok', message: `包框与 ${def.label} 比例匹配` }
}
