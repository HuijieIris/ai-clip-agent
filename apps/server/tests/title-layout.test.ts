import {test,expect} from 'bun:test'
import {titleLines} from '../../../packages/shared/title-layout'
import {subtitleStyleFor,defaultTextStyle} from '../../../packages/shared/packaging'
test('新闻标题平衡换行：三行以内，不以标点开头，不丢文字',()=>{
 const text='美国芯片制造面临长期电力瓶颈：中国发电量约为其三倍'
 const lines=titleLines(text,14,t=>Array.from(t).length)
 expect(lines.length).toBeLessThanOrEqual(3);expect(lines.every(t=>!/^[:：，。]/.test(t))).toBe(true);expect(lines.join('')).toBe(text)
 const lengths=lines.map(t=>Array.from(t).length);expect(Math.max(...lengths)-Math.min(...lengths)).toBeLessThanOrEqual(4)
 const chip=titleLines('如何保障逻辑与内存芯片的本土产能成核心挑战',13,t=>t.length);expect(chip.every((line,i)=>!(line.endsWith('芯')&&chip[i+1]?.startsWith('片')))).toBe(true)
 expect(titleLines('用户手工\n指定换行',20,t=>t.length)).toEqual(['用户手工','指定换行'])
})
test('成片字幕与二次剪辑独立样式：保留编辑32号，成片56号下移',()=>{
 const editing={...defaultTextStyle(32),y:.5},final={...defaultTextStyle(56),y:.62}
 const p:any={subtitleStyle:editing,finalSubtitleStyle:final,subtitleLayoutVersion:2}
 expect(subtitleStyleFor(p).fontSize).toBe(56);expect(subtitleStyleFor(p).y).toBe(.62);expect(p.subtitleStyle.fontSize).toBe(32);expect(p.subtitleStyle.y).toBe(.5)
})


test('标题描边粗细实际生效，按导出分辨率缩放，零值关闭描边',async()=>{
 const {renderTitlePng}=await import('../src/subtitles')
 const {createCanvas,loadImage}=await import('@napi-rs/canvas')
 const {mkdtempSync,rmSync}=await import('node:fs')
 const {tmpdir}=await import('node:os')
 const {join}=await import('node:path')
 const dir=mkdtempSync(join(tmpdir(),'title-outline-'))
 const black=async(width:number)=>{
   const path=join(dir,`${width}.png`)
   renderTitlePng('科技标题',320,480,path,{...defaultTextStyle(36),y:.2,outline:true,outlineWidth:width},320)
   const canvas=createCanvas(320,480),ctx=canvas.getContext('2d');ctx.drawImage(await loadImage(path),0,0)
   const pixels=ctx.getImageData(0,0,320,480).data;let count=0
   for(let i=0;i<pixels.length;i+=4)if(pixels[i]<20&&pixels[i+1]<20&&pixels[i+2]<20&&pixels[i+3]>200)count++
   return count
 }
 try{expect(await black(12)).toBeGreaterThan(await black(2));expect(await black(0)).toBe(0)}finally{rmSync(dir,{recursive:true,force:true})}
})

test('成片轨道字幕移动与裁剪采用输出时间，不篡改源字幕',async()=>{
 const {outputSubtitles}=await import('../../../packages/shared/packaging')
 const clip:any={subtitleMode:'en',subtitles:[{id:'a',start:0,end:1000,text:'One.'},{id:'b',start:1000,end:2000,text:'Two.'}],packaging:{subtitleOffsetMs:500,subtitleRange:{start:700,end:1800}}}
 const result=outputSubtitles(clip)
 expect(result.map(x=>[x.start,x.end])).toEqual([[700,1500],[1500,1800]])
 expect(clip.subtitles[0].start).toBe(0)
})
