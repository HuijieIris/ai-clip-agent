import {test,expect} from 'bun:test'
import {mkdtempSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {renderClip,probe} from '../src/ffmpeg'
async function ff(args:string[]){const p=Bun.spawn(['ffmpeg','-y',...args],{stdout:'pipe',stderr:'pipe'});const [out,err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);if(code)throw Error(err);return out+err}
async function rms(file:string){const log=await ff(['-i',file,'-af','bandpass=f=200:width_type=h:width=30,astats=metadata=0:reset=0','-f','null','-']);const value=[...log.matchAll(/RMS level dB:\s*(-?[\d.]+)/g)].at(-1)?.[1];if(!value)throw Error(log);return +value}
test('真实混音：循环配乐、淡入淡出、人声避让、无原声视频及区间限制',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'music-render-'))
 try{
  const input=join(dir,'voice.mp4'),silent=join(dir,'silent.mp4'),music=join(dir,'music.wav')
  await ff(['-f','lavfi','-i','color=c=red:s=160x120:r=30:d=3','-f','lavfi','-i','sine=frequency=880:duration=3','-c:v','libx264','-c:a','aac','-shortest',input])
  await ff(['-f','lavfi','-i','color=c=blue:s=160x120:r=30:d=3','-c:v','libx264',silent])
  await ff(['-f','lavfi','-i','sine=frequency=200:duration=1',music])
  const opts={input,startMs:0,endMs:3000,canvasW:160,canvasH:120,viewport:{x:0,y:0,width:160,height:120}}
  const bgm={enabled:true,trackId:'test',file:music,volume:.6,sourceIn:200,start:0,end:3000,fadeIn:100,fadeOut:100,ducking:false}
  const normal=join(dir,'normal.mp4'),duck=join(dir,'duck.mp4'),only=join(dir,'only.mp4')
  expect((await renderClip({...opts,output:normal,bgm})).ok).toBe(true)
  expect((await renderClip({...opts,output:duck,bgm:{...bgm,ducking:true}})).ok).toBe(true)
  expect(await rms(duck)).toBeLessThan((await rms(normal))-3)
  expect((await renderClip({...opts,input:silent,output:only,bgm:{...bgm,start:500,end:2500}})).ok).toBe(true)
  const info=await probe(only);expect(info.hasAudio).toBe(true);expect(Math.abs(info.duration-3000)).toBeLessThan(150)
 }finally{rmSync(dir,{recursive:true,force:true})}
},20000)
