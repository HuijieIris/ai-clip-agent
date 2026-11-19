import { createCanvas } from '@napi-rs/canvas'
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { renderClip, run, probe } from '../src/ffmpeg'

async function pixel(file: string, time: number, x = 80, y = 60) {
  const p = Bun.spawn(
    [
      'ffmpeg',
      '-v',
      'error',
      '-ss',
      String(time),
      '-i',
      file,
      '-frames:v',
      '1',
      '-vf',
      `crop=2:2:${x}:${y},scale=1:1`,
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      'pipe:1',
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const [bytes, err, code] = await Promise.all([
    new Response(p.stdout).arrayBuffer(),
    new Response(p.stderr).text(),
    p.exited,
  ])
  if (code) throw Error(err)
  return [...new Uint8Array(bytes)]
}
async function tone(file: string, time: number) {
  const p = Bun.spawn(
    [
      'ffmpeg',
      '-v',
      'error',
      '-ss',
      String(time),
      '-t',
      '0.2',
      '-i',
      file,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-f',
      'f32le',
      'pipe:1',
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const [buffer, err, code] = await Promise.all([
    new Response(p.stdout).arrayBuffer(),
    new Response(p.stderr).text(),
    p.exited,
  ])
  if (code) throw Error(err)
  const samples = new Float32Array(buffer)
  let crossings = 0
  for (let i = 1; i < samples.length; i++) if (samples[i - 1] <= 0 && samples[i] > 0) crossings++
  return crossings / (samples.length / 16000)
}
test('真实FFmpeg内删：红绿蓝去中段，声音440/880Hz同步，画布窗口固定、无音轨也可导出', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'edit-render-'))
  try {
    const input = join(dir, 'source.mp4')
    const made = await run('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=red:s=160x120:r=30:d=1',
      '-f',
      'lavfi',
      '-i',
      'color=green:s=160x120:r=30:d=1',
      '-f',
      'lavfi',
      '-i',
      'color=blue:s=160x120:r=30:d=1',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=1',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=660:duration=1',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=880:duration=1',
      '-filter_complex',
      '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v];[3:a][4:a][5:a]concat=n=3:v=0:a=1[a]',
      '-map',
      '[v]',
      '-map',
      '[a]',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      input,
    ])
    expect(made.code).toBe(0)
    const output = join(dir, 'cut.mp4'),
      opts = {
        input,
        output,
        startMs: 0,
        endMs: 3000,
        canvasW: 240,
        canvasH: 200,
        viewport: { x: 40, y: 40, width: 160, height: 120 },
        spans: [
          { sourceIn: 0, sourceOut: 1000 },
          { sourceIn: 2000, sourceOut: 3000 },
        ],
        transform: { scale: 1.5, offsetX: 20, offsetY: 0 },
      }
    const result = await renderClip(opts)
    expect(result).toEqual({ ok: true, message: 'ok' })
    expect(Math.abs((await probe(output)).duration - 2000)).toBeLessThan(150)
    const red = await pixel(output, 0.3),
      blue = await pixel(output, 1.3),
      outside = await pixel(output, 0.3, 20, 60)
    expect(red[0]).toBeGreaterThan(200)
    expect(red[2]).toBeLessThan(30)
    expect(blue[2]).toBeGreaterThan(200)
    expect(outside[0]).toBeGreaterThan(180) // source-derived background replaces black padding
    expect(Math.abs((await tone(output, 0.2)) - 440)).toBeLessThan(20)
    expect(Math.abs((await tone(output, 1.2)) - 880)).toBeLessThan(20)
    const replaced = join(dir, 'replaced.mp4')
    expect(
      (
        await renderClip({
          ...opts,
          output: replaced,
          replacements: [{ startMs: 1000, endMs: 2000, file: input, keepAudio: true, assetIn: 1000 }],
        })
      ).ok,
    ).toBe(true)
    const green = await pixel(replaced, 1.3)
    expect(green[1]).toBeGreaterThan(90)
    expect(green[2]).toBeLessThan(30)
    const canvas = createCanvas(240, 200),
      ctx = canvas.getContext('2d')
    ctx.fillStyle = 'red'
    ctx.fillRect(0, 0, 240, 20)
    const body = join(dir, 'body.png')
    writeFileSync(body, canvas.toBuffer('image/png'))
    ctx.clearRect(0, 0, 240, 200)
    ctx.fillStyle = 'blue'
    ctx.fillRect(0, 0, 240, 20)
    const frame = join(dir, 'cover-frame.png')
    writeFileSync(frame, canvas.toBuffer('image/png'))
    ctx.fillStyle = 'green'
    ctx.fillRect(0, 0, 240, 200)
    const cover = join(dir, 'cover.png')
    writeFileSync(cover, canvas.toBuffer('image/png'))
    const branded = join(dir, 'branded.mp4')
    expect(
      (
        await renderClip({
          ...opts,
          output: branded,
          framePng: body,
          coverFramePng: frame,
          coverImage: cover,
          firstScreenMs: 500,
        })
      ).ok,
    ).toBe(true)
    expect((await pixel(branded, 0.2, 20, 10))[2]).toBeGreaterThan(200)
    expect((await pixel(branded, 0.8, 20, 10))[0]).toBeGreaterThan(200)
    const firstFrameCover = join(dir, 'first-frame-cover.mp4')
    expect((await renderClip({...opts,output:firstFrameCover,framePng:body,coverFramePng:frame,coverImage:cover,firstScreenMs:1000/30})).ok).toBe(true)
    expect((await pixel(firstFrameCover,0,20,10))[2]).toBeGreaterThan(200)
    expect((await pixel(firstFrameCover,.1,20,10))[0]).toBeGreaterThan(200)
    expect(Math.abs((await probe(firstFrameCover)).duration-2000)).toBeLessThan(150)
    ctx.clearRect(0, 0, 240, 200)
    ctx.fillStyle = '#ff00ff'
    ctx.fillRect(10, 10, 100, 12)
    const bodyTitle = join(dir, 'body-title.png')
    writeFileSync(bodyTitle, canvas.toBuffer('image/png'))
    const titled = join(dir, 'titled.mp4')
    expect(
      (await renderClip({ ...opts, output: titled, bodyTitlePng: bodyTitle, bodyTitleEndMs: 500 })).ok,
    ).toBe(true)
    const visible = await pixel(titled, 0.2, 20, 16),
      hidden = await pixel(titled, 0.8, 20, 16)
    expect(visible[0]).toBeGreaterThan(200)
    expect(visible[2]).toBeGreaterThan(200)
    expect(hidden[2]).toBeLessThan(30) // title disappears, source-derived red backdrop remains
    const silent = join(dir, 'silent.mp4')
    expect(
      (await run('ffmpeg', ['-v', 'error', '-y', '-i', input, '-c:v', 'copy', '-an', silent])).code,
    ).toBe(0)
    const silentOut = join(dir, 'silent-out.mp4')
    expect((await renderClip({ ...opts, input: silent, output: silentOut })).ok).toBe(true)
    expect((await probe(silentOut)).hasAudio).toBe(false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}, 30000)
