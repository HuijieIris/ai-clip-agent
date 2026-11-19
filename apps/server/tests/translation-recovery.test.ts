import { describe, expect, test } from 'bun:test'
import type { TranscriptSegment } from '../src/types'
import type { ModelClient } from '../src/highlights/model'
import { ModelOutputError } from '../src/highlights/model'
import { batches, translateTranscript } from '../src/highlights/translation'
import { createSearchSession } from '../src/highlights/search'
import type { Translation } from '../../../packages/shared/highlights'

const segments:TranscriptSegment[]=Array.from({length:4},(_,i)=>({id:`sentence_${i}`,start:i*1000,end:(i+1)*1000,text:`This is an English sentence number ${i} that needs translating.`}))
const result=(ss:TranscriptSegment[],review:boolean)=>({items:ss.map(s=>({segmentId:s.id,textZh:'这是对应的中文译文。',...(review?{status:'reviewed',issues:[]}: {})}))})
const noSearch=()=>createSearchSession(undefined,'off')

describe('翻译漏句恢复',()=>{
 test('实际字幕量分批不超过18句',()=>{
  const many=Array.from({length:546},(_,i)=>({...segments[0],id:`s_${i}`}))
  const bs=batches(many)
  expect(bs.every(b=>b.length<=18)).toBe(true)
  expect(bs.flat().map(s=>s.id)).toEqual(many.map(s=>s.id))
 })
 test('翻译与复核分别只补遗漏ID，不重译已经返回的句子',async()=>{
  const calls:{stage:string;ids:string[]}[]=[]
  const model:ModelClient={async ask(stage,_task,input:any,validate){
   calls.push({stage,ids:input.segments.map((s:any)=>s.id)})
   const ss=input.segments as TranscriptSegment[]
   return validate(result(ss.length===4?ss.slice(0,2):ss,stage==='translation_review'))
  }}
  const output=await translateTranscript(segments,model,noSearch())
  expect(output.map(t=>t.segmentId)).toEqual(segments.map(s=>s.id))
  expect(calls).toEqual([
   {stage:'translate',ids:segments.map(s=>s.id)},
   {stage:'translate',ids:segments.slice(2).map(s=>s.id)},
   {stage:'translation_review',ids:segments.map(s=>s.id)},
   {stage:'translation_review',ids:segments.slice(2).map(s=>s.id)},
  ])
  expect(output.every(t=>t.status==='reviewed')).toBe(true)
 })
 test('模型顺序变化不会错配句子，context不是输出目标',async()=>{
  const model:ModelClient={async ask(stage,_task,input:any,validate){return validate(result([...input.segments].reverse(),stage==='translation_review'))}}
  expect((await translateTranscript(segments,model,noSearch())).map(t=>t.segmentId)).toEqual(segments.map(s=>s.id))
 })
 test('模型反复遗漏时退到单句补齐，不生成占位译文',async()=>{
  let singleton=0
  const model:ModelClient={async ask(stage,_task,input:any,validate){
   if(input.segments.length===1)singleton++
   return validate(result(input.segments.length>1?[]:input.segments,stage==='translation_review'))
  }}
  const out=await translateTranscript(segments,model,noSearch())
  expect(out).toHaveLength(4);expect(singleton).toBe(8)
 })
 test('单句仍无结果明确失败并携带句子ID',async()=>{
  const model:ModelClient={async ask(_stage,_task,_input,validate){return validate({items:[]})}}
  await expect(translateTranscript(segments.slice(0,1),model,noSearch())).rejects.toThrow('sentence_0')
 })
 test('结构错误可进一步拆小，鉴权错误不拆分重试',async()=>{
  let calls=0
  const model:ModelClient={async ask(stage,_task,input:any,validate){calls++;if(input.segments.length>2)throw new ModelOutputError('格式错误');return validate(result(input.segments,stage==='translation_review'))}}
  expect((await translateTranscript(segments,model,noSearch()))).toHaveLength(4)
  expect(calls).toBe(6)
  let failures=0
  const denied:ModelClient={async ask(){failures++;throw new Error('HTTP 401')}}
  await expect(translateTranscript(segments,denied,noSearch())).rejects.toThrow('HTTP 401')
  expect(failures).toBe(1)
 })
 test('复用已完成译文，不再次调用模型',async()=>{
  const previous:Translation[]=segments.map(s=>({segmentId:s.id,textZh:'已有的中文译文。',status:'reviewed',issues:[]}))
  const model:ModelClient={async ask(){throw new Error('不应再次请求')}}
  expect(await translateTranscript(segments,model,noSearch(),undefined,undefined,previous)).toEqual(previous)
 })
 test('批次并发不超过3，失败后等待在途任务停止，不再发布结果',async()=>{
  const many=Array.from({length:72},(_,i)=>({...segments[i%4],id:`sentence_${i}`}))
  let active=0,maxActive=0,published=0
  const model:ModelClient={async ask(stage,_task,input:any,validate,signal){
   active++;maxActive=Math.max(maxActive,active)
   try{await Bun.sleep(5);signal?.throwIfAborted();return validate(result(input.segments,stage==='translation_review'))}finally{active--}
  }}
  expect(await translateTranscript(many,model,noSearch())).toHaveLength(72)
  expect(maxActive).toBe(3);expect(active).toBe(0)
  const failing:ModelClient={async ask(_stage,_task,input:any,_validate,signal){
   if(input.segments[0].id==='sentence_0')throw new Error('stop')
   await Bun.sleep(10);signal?.throwIfAborted();throw new Error('late')
  }}
  await expect(translateTranscript(many,failing,noSearch(),undefined,()=>{published++})).rejects.toThrow('stop')
  await Bun.sleep(15);expect(published).toBe(0)
 })
 test('含长英文技术名的中文译文不误判成未翻译，孤立专名可保留并标疑点',async()=>{
  const ss=[{id:'name_1',start:0,end:1000,text:"One is called OpenShell, a containment system."},{id:'name_2',start:1000,end:2000,text:'Bluefield,'}]
  const model:ModelClient={async ask(stage,_task,input:any,validate){return validate({items:input.segments.map((s:any)=>({segmentId:s.id,textZh:s.id==='name_1'?'OpenShell隔离系统':'Bluefield',...(stage==='translation_review'?{status:'reviewed',issues:[]}: {})}))})}}
  const out=await translateTranscript(ss,model,noSearch())
  expect(out[0].textZh).toBe('OpenShell隔离系统');expect(out[0].status).toBe('reviewed')
  expect(out[1].textZh).toBe('Bluefield');expect(out[1].status).toBe('needs_review')
 })
 test('未知编号或重复编号始终拒绝',async()=>{
  for(const malformed of [[{segmentId:'invented',textZh:'错误编号'}],[{segmentId:'sentence_0',textZh:'重复'},{segmentId:'sentence_0',textZh:'重复'}]]){
   const model:ModelClient={async ask(_stage,_task,_input,validate){return validate({items:malformed})}}
   await expect(translateTranscript(segments,model,noSearch())).rejects.toThrow('编号')
  }
 })
})
