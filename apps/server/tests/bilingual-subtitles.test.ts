import { test, expect } from 'bun:test'
import { outputSubtitles, inferredSubtitleMode, defaultTextStyle } from '../../../packages/shared/packaging'
import { renderSubtitlePng } from '../src/subtitles'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('英文默认双语，三种模式切换保留原文、译文和时间映射', () => {
  const clip: any = {
    subtitles: [{ id: 'a', start: 0, end: 2000, text: 'We need more power.' }],
    editPlan: { spans: [{ id: 'a', sourceIn: 1000, sourceOut: 3000 }] },
    packaging: {
      sourceCues: [
        {
          id: 'cue',
          start: 1000,
          end: 3000,
          original: 'We need more power.',
          text: '我们需要更多电力',
          highlights: [],
        },
      ],
    },
  }
  const before = JSON.stringify(clip.packaging)
  expect(inferredSubtitleMode(clip)).toBe('bilingual')
  expect(outputSubtitles(clip)[0]).toMatchObject({
    text: '我们需要更多电力',
    english: 'We need more power',
    start: 0,
    end: 2000,
  })
  expect(outputSubtitles({ ...clip, subtitleMode: 'zh' })[0]).toMatchObject({
    text: '我们需要更多电力',
    english: undefined,
  })
  expect(outputSubtitles({ ...clip, subtitleMode: 'en' })[0]).toMatchObject({
    text: 'We need more power',
    english: undefined,
  })
  expect(JSON.stringify(clip.packaging)).toBe(before)
  expect(inferredSubtitleMode({ subtitles: [{ text: '人工智能技术与 Azure 的应用' }] })).toBe('zh')
  expect(outputSubtitles({ subtitles: clip.subtitles, subtitleMode: 'en' })[0].text).toBe(
    'We need more power',
  )
})
test('双语真实图层：上中文下英文，无背景阴影、纯黑15px描边，按分辨率缩放', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bilingual-png-'))
  try {
    const style = { ...defaultTextStyle(48), y: 0.35, background: true, outlineWidth: 15 }
    const image = join(dir, 'dual.png')
    await renderSubtitlePng('中文在上', 'English below', 1080, 800, image, style, 1080)
    const c = createCanvas(1080, 800),
      ctx = c.getContext('2d')
    ctx.drawImage(await loadImage(image), 0, 0)
    const px = ctx.getImageData(0, 0, 1080, 800).data
    let top = 0,
      bottom = 0,
      black = 0
    for (let y = 0; y < 800; y++)
      for (let x = 0; x < 1080; x++) {
        const i = (y * 1080 + x) * 4
        if (px[i + 3] > 200) {
          if (y < 400) top++
          else bottom++
          if (px[i] < 8 && px[i + 1] < 8 && px[i + 2] < 8) black++
        }
      }
    expect(top).toBeGreaterThan(100)
    expect(bottom).toBeGreaterThan(100)
    expect(black).toBeGreaterThan(100)
    expect([...ctx.getImageData(0, 0, 1, 1).data]).toEqual([0, 0, 0, 0])
    expect([...ctx.getImageData(400, 250, 1, 1).data]).toEqual([0, 0, 0, 0])
    const small = join(dir, 'small.png')
    await renderSubtitlePng('中文在上', 'English below', 540, 400, small, style, 1080)
    const s = createCanvas(540, 400),
      sc = s.getContext('2d')
    sc.drawImage(await loadImage(small), 0, 0)
    expect(sc.getImageData(0, 0, 1, 1).data[3]).toBe(0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
