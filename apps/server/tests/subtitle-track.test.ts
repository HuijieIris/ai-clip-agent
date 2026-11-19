import {test,expect} from 'bun:test'
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createCanvas} from '@napi-rs/canvas'
import {subtitleTrack} from '../src/subtitle-track'
import {renderClip,run,probe} from '../src/ffmpeg'
test('稀疏字幕轨：毫秒切换、空隙透明、输出保持30fps，重叠字幕回退独立图层',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'subtitle-track-'));try{
 const source=join(dir,'source.mp4');expect((await run('ffmpeg',['-v','error','-y','-f','lavfi','-i','color=green:s=160x120:r=30:d=2','-c:v','libx264',source])).code).toBe(0)
 const canvas=createCanvas(160,120),ctx=canvas.getContext('2d');ctx.fillStyle='red';ctx.fillRect(0,0,160,120);const red=join(dir,"red's.png");writeFileSync(red,canvas.toBuffer('image/png'));ctx.fillStyle='blue';ctx.fillRect(0,0,160,120);const blue=join(dir,'blue.png');writeFileSync(blue,canvas.toBuffer('image/png'))
 const cues=[{pngPath:red,startMs:0,endMs:500},{pngPath:blue,startMs:1000,endMs:1500}]
 expect(subtitleTrack([{...cues[0],endMs:1200},cues[1]],2000,160,120,join(dir,'overlap'))).toBeNull()
 const output=join(dir,'out.mp4');expect((await renderClip({input:source,output,startMs:0,endMs:2000,canvasW:160,canvasH:120,viewport:{x:0,y:0,width:160,height:120},subtitlePngs:cues})).ok).toBe(true)
 const info=await probe(output);expect(info.fps).toBe(30);expect(Math.abs(info.duration-2000)).toBeLessThan(100)
 const pixel=async(time:string)=>{const p=Bun.spawn(['ffmpeg','-v','error','-ss',time,'-i',output,'-frames:v','1','-vf','scale=1:1','-pix_fmt','rgb24','-f','rawvideo','pipe:1'],{stdout:'pipe',stderr:'pipe'});const data=[...new Uint8Array(await new Response(p.stdout).arrayBuffer())];await p.exited;return data}
 expect((await pixel('0.2'))[0]).toBeGreaterThan(200);expect((await pixel('0.7'))[1]).toBeGreaterThan(90);expect((await pixel('1.2'))[2]).toBeGreaterThan(200);expect((await pixel('1.7'))[1]).toBeGreaterThan(90)
 }finally{rmSync(dir,{recursive:true,force:true})}
},15000)
