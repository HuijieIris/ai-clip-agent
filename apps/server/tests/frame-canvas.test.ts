import { test, expect } from 'bun:test'
import { createCanvas } from '@napi-rs/canvas'
import { writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { UPLOAD_DIR } from '../src/store'
import { adaptCanvasToFrame } from '../src/branding/service'
test('上传包框原始尺寸决定画布，区域同比换算，不接受不同比例封面', async () => {
  const name=`canvas-test-${crypto.randomUUID()}.png`,path=join(UPLOAD_DIR,'frames',name)
  const other=`canvas-other-${crypto.randomUUID()}.png`,otherPath=join(UPLOAD_DIR,'frames',other)
  try {
    writeFileSync(path,createCanvas(108,234).toBuffer('image/png'))
    writeFileSync(otherPath,createCanvas(100,100).toBuffer('image/png'))
    const r=()=>({x:10,y:20,width:80,height:100})
    const t:any={canvas:{width:100,height:160},bodyFrameUrl:`/files/uploads/frames/${name}`,coverFrameUrl:`/files/uploads/frames/${name}`,videoViewport:r(),subtitleSafeArea:r(),coverTitleSafeArea:r()}
    await adaptCanvasToFrame(t)
    expect(t.canvas).toEqual({width:108,height:234})
    expect(t.videoViewport).toEqual({x:11,y:29,width:86,height:146})
    const snapshot=JSON.stringify(t)
    await adaptCanvasToFrame(t)
    expect(JSON.stringify(t)).toBe(snapshot)
    t.coverFrameUrl=`/files/uploads/frames/${other}`
    await expect(adaptCanvasToFrame(t)).rejects.toThrow('比例不同')
  } finally {rmSync(path,{force:true});rmSync(otherPath,{force:true})}
})
