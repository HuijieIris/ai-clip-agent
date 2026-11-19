import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { TranscriptSegment } from '../src/types'
import type { AudioReview, HighlightRun, SearchResult } from '../../../packages/shared/highlights'
import { recommendHighlights, windows } from '../src/highlights/workflow'
import type { ModelClient } from '../src/highlights/model'
import { createModelClient } from '../src/highlights/model'
import { WEIGHTS, score, validRange, validateSegments, quote, signals } from '../src/highlights/validation'
import { publicUrl, createSearchSession, webSearch } from '../src/highlights/search'
import { parseAudio, reviewAudio } from '../src/highlights/audio'
import { splitTimedSegment } from '../src/text'
import { run } from '../src/ffmpeg'

const originalEnv={...process.env}
let server:ReturnType<typeof Bun.serve>|undefined
let fetchSpy:ReturnType<typeof spyOn>|undefined
let dir=''
beforeEach(()=>{process.env.HIGHLIGHT_API_KEY='';process.env.OPENAI_API_KEY='';process.env.TAVILY_API_KEY='';process.env.AUDIO_REVIEW_API_KEY='';dir=mkdtempSync(join(tmpdir(),'highlight-tests-'))})
afterEach(()=>{fetchSpy?.mockRestore();fetchSpy=undefined;server?.stop(true);server=undefined;rmSync(dir,{recursive:true,force:true});for(const key of Object.keys(process.env))if(!(key in originalEnv))delete process.env[key];Object.assign(process.env,originalEnv)})
const english:TranscriptSegment[]=[
  {id:'s1',start:0,end:10000,text:'We did not cut prices. That was the important decision.'},
  {id:'s2',start:10000,end:20000,text:'Instead, we fixed delivery. Sales increased by 20 percent.'},
  {id:'s3',start:20000,end:30000,text:'This only worked for our existing customers.'},
  {id:'s4',start:30000,end:40000,text:'Finally, test the process before expanding it.'},
]
const chinese=english.map((s,i)=>({...s,text:['我们没有降价，这是关键决定。','我们改进交付，销售额增长百分之二十。','这只适用于已有客户。','最后应先验证流程再扩大。'][i]}))
const translations=['我们没有降价。这是重要的决定。','相反，我们改进交付，销售额增长了百分之二十。','这只适用于我们的已有客户。','最后，在扩大之前先验证流程。']
function fakeModel(segments:TranscriptSegment[],config:{invalidId?:boolean;empty?:boolean;low?:boolean;duplicate?:boolean;repair?:boolean;badQuote?:boolean;foreignTranslation?:boolean;needsReview?:boolean}={}) {
  const stages:string[]=[]
  const model:ModelClient={async ask<T>(stage,_task,input:any,validate:(v:unknown)=>T):Promise<T>{
    stages.push(stage)
    if(stage==='translate')return validate({items:segments.map((s,i)=>({segmentId:s.id,textZh:config.foreignTranslation?'still english':translations[i]}))})
    if(stage==='translation_review')return validate({items:segments.map((s,i)=>({segmentId:s.id,textZh:translations[i],status:config.needsReview&&i===1?'needs_review':'reviewed',issues:config.needsReview&&i===1?['数字需回听']:[]}))})
    if(stage==='recall')return validate({topics:[{summary:'经营案例',segmentIds:[segments[0].id]}],candidates:config.empty?[]:Array.from({length:config.duplicate?2:1},(_,i)=>({startSegmentId:config.invalidId?'invented':segments[i].id,endSegmentId:segments.at(-1)!.id,coreSegmentIds:[segments[i].id],title:'没有降价之后的经营变化',reason:'包含具体行动和结果。',signals:[]})),queries:[]})
    if(stage==='global_review'||stage==='boundary_repair')return validate({reviews:input.candidates.map((c:any,i:number)=>({candidateId:c.id,decision:config.repair&&stage==='global_review'?'needs_boundary_repair':'accept',startSegmentId:c.startSegmentId,endSegmentId:c.endSegmentId,title:'没有降价之后的经营变化',reason:'包含具体行动和结果，并保留了适用范围。',tags:['经营'],dimensions:Object.fromEntries(Object.keys(WEIGHTS).map(key=>[key,{score:config.low&&key==='semantic_completeness'?2:4,reason:'有原文支持。',segmentIds:[c.startSegmentId]}])),evidence:[{segmentId:c.startSegmentId,quote:config.badQuote?'不存在的引用':segments.find(s=>s.id===c.startSegmentId)!.text}],duplicateOf:null,reviewFlags:[],rejectionReason:null}))})
    throw new Error(`unexpected stage ${stage}`)
  }}
  return {model,stages}
}
const opts={minDuration:20000,maxDuration:45000,count:3,durationMs:40000,searchMode:'off' as const}
describe('双语高光工作流（隔离模型，不代表真实模型效果）',()=>{
 test('英文先翻译和独立复核，原文时间不变，后端计算评分',async()=>{
  const {model,stages}=fakeModel(english)
  const result=await recommendHighlights(english,opts,{model})
  expect(stages).toEqual(['translate','translation_review','recall','global_review'])
  expect(result.highlights[0].start).toBe(0);expect(result.highlights[0].end).toBe(40000)
  expect(result.highlights[0].score).toBe(76)
  expect(result.highlights[0].transcript).toContain('did not')
  expect(result.highlights[0].details?.transcriptZh).toContain('没有降价')
  expect(result.highlights[0].details?.dimensions.audience_fit.score).toBe(3)
  expect(result.highlights[0].details?.audio.status).toBe('unavailable')
  expect(result.run.warnings.join()).toContain('未为凑数')
 })
 test('中文不额外翻译；空候选是成功业务结果',async()=>{
  const {model,stages}=fakeModel(chinese,{empty:true})
  const result=await recommendHighlights(chinese,opts,{model})
  expect(stages).toEqual(['recall']);expect(result.highlights).toEqual([]);expect(result.run.status).toBe('completed')
  expect(result.translations.every(t=>t.status==='original_zh')).toBe(true)
 })
 test('译文问题保留待核对标记，不虚报原声已验证',async()=>{
  const {model}=fakeModel(english,{needsReview:true})
  const result=await recommendHighlights(english,opts,{model})
  expect(result.highlights[0].details?.reviewFlags).toContain('translation_needs_review')
  expect(result.translations[1].issues).toContain('数字需回听')
 })
 test('候选原声复听来自音频工具，时间与文本推断分开',async()=>{
  const {model}=fakeModel(chinese)
  const audio:AudioReview={status:'reviewed',observations:[{label:'停顿',start:1000,end:2000,evidence:'句间停顿',certainty:'clear'}],transcriptCheck:'consistent',issues:[]}
  const result=await recommendHighlights(chinese,{...opts,audioPath:'test-only'},{model,audio:async input=>{expect(input.original).toContain('我们没有降价');return audio}})
  expect(result.highlights[0].details?.audio.observations[0].start).toBe(1000)
 })
 test('不存在的句子、伪造引用和外文译文被拒绝',async()=>{
  for(const settings of [{invalidId:true},{badQuote:true},{foreignTranslation:true}]){
   const {model}=fakeModel(english,settings)
   await expect(recommendHighlights(english,opts,{model})).rejects.toThrow()
  }
 })
 test('低完整性即使其他分高也不入选；不合格不凑数',async()=>{
  const {model}=fakeModel(chinese,{low:true})
  expect((await recommendHighlights(chinese,opts,{model})).highlights).toHaveLength(0)
 })
 test('全局复评后做强重叠去重',async()=>{
  const {model}=fakeModel(chinese,{duplicate:true})
  const result=await recommendHighlights(chinese,opts,{model})
  expect(result.highlights).toHaveLength(1);expect(result.run.rejectionReasons.join()).toContain('强重叠')
 })
 test('允许一次边界修复，不直接执行模型给的毫秒',async()=>{
  const {model,stages}=fakeModel(chinese,{repair:true})
  expect((await recommendHighlights(chinese,opts,{model})).highlights).toHaveLength(1)
  expect(stages).toContain('boundary_repair')
 })
 test('召回核心句超出模型起止范围时，补齐真实边界后再复评',async()=>{
  const base=fakeModel(chinese).model
  const model:ModelClient={async ask(stage,task,input,validate,signal){
   if(stage==='recall')return base.ask(stage,task,input,value=>{
    const v=value as any;v.candidates[0].endSegmentId='s1';v.candidates[0].coreSegmentIds=['s3'];return validate(v)
   },signal)
   return base.ask(stage,task,input,validate,signal)
  }}
  const result=await recommendHighlights(chinese,opts,{model})
  expect(result.highlights[0].end).toBe(30000)
 })
 test('仅落在相邻上下文的候选跳过而不终止，所属窗口仍可召回',async()=>{
  const many=Array.from({length:50},(_,i)=>({id:`s${i}`,start:i*10000,end:(i+1)*10000,text:'这里是完整的中文测试内容。'}))
  const base=fakeModel(many).model
  const model:ModelClient={async ask(stage,task,input:any,validate,signal){
   if(stage==='recall')return validate({topics:[],queries:[],candidates:input.segments.some((s:any)=>s.id==='s25')?[{startSegmentId:'s25',endSegmentId:'s27',coreSegmentIds:['s25'],title:'上下文中的候选',reason:'有具体内容。',signals:[]}]:[]})
   return base.ask(stage,task,input,validate,signal)
  }}
  const result=await recommendHighlights(many,{...opts,durationMs:500000},{model})
  expect(result.highlights).toHaveLength(1);expect(result.highlights[0].start).toBe(250000)
 })
 test('只返回句子ID时，信号和证据由后端取原文，仍拒绝主动伪造的quote',()=>{
  expect(quote({segmentId:'s1'},english).quote).toBe(english[0].text)
  expect(signals([{ruleId:'viewpoint',segmentIds:['s1']}],english)[0].quote).toBe(english[0].text)
  expect(()=>quote({segmentId:'s1',quote:'模型编造的引用'},english)).toThrow('原文')
 })
 test('缺失ASR区间不允许跨越',async()=>{
  const {model}=fakeModel(chinese)
  expect((await recommendHighlights(chinese,{...opts,missingRanges:[{start:15000,end:17000}]},{model})).highlights).toHaveLength(0)
 })
 test('缺凭据不会静默使用规则冒充AI，失败状态可保存',async()=>{
  let audit:HighlightRun|undefined
  await expect(recommendHighlights(chinese,opts,{onUpdate:r=>{audit=structuredClone(r)}})).rejects.toThrow('未配置高光文本模型')
  expect(audit?.status).toBe('failed');expect(audit?.translations).toHaveLength(4)
 })
 test('仅在原文、模型和提示版本一致时复用已完成双语结果',async()=>{
  const first=fakeModel(english)
  const result=await recommendHighlights(english,opts,{model:first.model})
  const second=fakeModel(english)
  await recommendHighlights(english,{...opts,resumeRun:result.run},{model:second.model})
  expect(second.stages).toEqual(['recall','global_review'])
  const changed=fakeModel(english)
  await recommendHighlights(english,{...opts,resumeRun:{...result.run,transcriptVersion:'different'}},{model:changed.model})
  expect(changed.stages[0]).toBe('translate')
 })
 test('复评失败后保留召回保存点，重试不再请求分段模型',async()=>{
  const base=fakeModel(english).model
  let failed:HighlightRun|undefined
  const failing:ModelClient={async ask(stage,task,input,validate,signal){
   if(stage==='global_review')throw new Error('review unavailable')
   return base.ask(stage,task,input,validate,signal)
  }}
  await expect(recommendHighlights(english,opts,{model:failing,onUpdate:run=>{failed=structuredClone(run)}})).rejects.toThrow('review unavailable')
  expect(failed?.recall?.completedWindows).toBe(1)
  const retry=fakeModel(english)
  await recommendHighlights(english,{...opts,resumeRun:failed},{model:retry.model})
  expect(retry.stages).toEqual(['global_review'])
  const changed=fakeModel(english)
  await recommendHighlights(english,{...opts,profile:'新的频道目标',resumeRun:failed},{model:changed.model})
  expect(changed.stages[0]).toBe('recall')
 })
 test('取消后不继续调用模型',async()=>{
  const {model,stages}=fakeModel(chinese),controller=new AbortController();controller.abort()
  await expect(recommendHighlights(chinese,{...opts,signal:controller.signal},{model})).rejects.toThrow()
  expect(stages).toHaveLength(0)
 })
 test('短于最短时长不静默放宽',async()=>{
  const {model}=fakeModel(chinese)
  expect((await recommendHighlights(chinese,{...opts,minDuration:45000,maxDuration:60000},{model})).highlights).toHaveLength(0)
 })
})

describe('工具与确定性校验',()=>{
 test('五维权重和为100，坏时间戳拒绝',()=>{
  expect(Object.values(WEIGHTS).reduce((a,b)=>a+b)).toBe(100)
  expect(()=>validateSegments([{...english[0],start:NaN}],40000)).toThrow()
  expect(validRange(0,1000,2000,5000)).toBe(false)
 })
 test('英文字幕不强制切为20字母，保留句末边界',()=>{
  const result=splitTimedSegment({start:0,end:20000,text:'We did not cut prices. Instead, we fixed delivery. Sales increased.'},20)
  expect(result.map(s=>s.text).join('')).toContain('Instead, we fixed delivery.')
  expect(result[0].text).toBe('We did not cut prices.')
 })
 test('窗口覆盖所有句子并保留足够相邻上下文',()=>{
  const segments=Array.from({length:80},(_,i)=>({id:`w${i}`,start:i*10000,end:(i+1)*10000,text:'这是窗口测试内容。'}))
  const result=windows(segments,120000)
  expect(result.flatMap(w=>w.owned).map(s=>s.id)).toEqual(segments.map(s=>s.id))
  expect(result[1].context.some(s=>s.id===result[0].owned.at(-1)?.id)).toBe(true)
 })
 test('联网工具不同用途保留时间策略，关闭和预算生效',async()=>{
  let count=0
  const tool=async(req:any):Promise<SearchResult>=>{count++;return {...req,status:'empty',sources:[],windowDays:req.purpose==='news'?7:null}}
  const disabled=createSearchSession(tool,'off');expect((await disabled.search({purpose:'news',query:'x'})).status).toBe('skipped');expect(count).toBe(0)
  const session=createSearchSession(tool)
  const first=await session.search({purpose:'translation',query:'name'});expect(first.windowDays).toBeNull()
  for(let i=0;i<8;i++)await session.search({purpose:'news',query:`query-${i}`})
  expect(count).toBe(6);expect(session.results.at(-1)?.status).toBe('error')
 })
 test('未配置搜索返回unavailable而非unmatched，拒绝私网链接',async()=>{
  expect((await webSearch({purpose:'news',query:'sample'})).status).toBe('unavailable')
  for(const url of ['http://127.0.0.1/x','http://10.0.0.1','http://169.254.169.254','file:///etc/passwd','http://localhost','http://[::1]'])expect(publicUrl(url)).toBeNull()
  expect(publicUrl('https://example.com/news')).toBe('https://example.com/news')
 })
 test('联网提供商返回来源日期与摘录，不捏造全文验证',async()=>{
  process.env.TAVILY_API_KEY='test-only'
  fetchSpy=spyOn(globalThis,'fetch').mockImplementation((async(_url:any,init:any)=>{
   const body=JSON.parse(init.body);expect(body.topic).toBe('general');expect(body.time_range).toBeUndefined()
   return Response.json({results:[{title:'术语来源',url:'https://example.com/article',content:'原始摘要',published_date:null}]})
  }) as any)
  const result=await webSearch({purpose:'translation',query:'unique-test-query'})
  expect(result.status).toBe('ok');expect(result.sources[0].publishedAt).toBeNull();expect(result.sources[0].evidenceLevel).toBe('snippet')
 })
 test('搜索工具异常降级，不把错误当作没有匹配结果',async()=>{
  const session=createSearchSession(async()=>{throw new Error('network')})
  expect((await session.search({purpose:'background',query:'test'})).status).toBe('error')
 })
 test('新闻关联不能引用模型编造的来源编号',async()=>{
  const base=fakeModel(chinese).model
  const model:ModelClient={async ask(stage,task,input,validate,signal){
   if(stage==='recall')return base.ask(stage,task,input,v=>{
    const result=v as any
    result.queries=[{purpose:'news',query:'经营案例 新闻'}]
    result.candidates[0].signals=[{ruleId:'timely_event',segmentIds:['s1'],quote:chinese[0].text}]
    return validate(result)
   },signal)
   if(stage==='news_match')return validate({matches:[{candidateId:(input as any).candidates[0].id,status:'matched',relation:'same_event',sourceIds:['invented-source'],reason:'测试'}]})
   return base.ask(stage,task,input,validate,signal)
  }}
  const search=async(req:any):Promise<SearchResult>=>({...req,status:'ok',windowDays:7,sources:[{id:'real-source',title:'搜索测试',url:'https://example.com',publisher:'example.com',publishedAt:null,retrievedAt:new Date().toISOString(),excerpt:'摘要',evidenceLevel:'snippet',originGroupId:'g1'}]})
  await expect(recommendHighlights(chinese,{...opts,searchMode:'auto'},{model,search})).rejects.toThrow('引用未知搜索来源')
 })
 test('文本模型HTTP错误不泄露上游响应或密钥，不静默降级',async()=>{
  server=Bun.serve({port:0,hostname:'127.0.0.1',fetch:()=>new Response('secret-detail-test-only',{status:401})})
  process.env.HIGHLIGHT_API_KEY='test-only-secret';process.env.HIGHLIGHT_BASE_URL=`http://127.0.0.1:${server.port}`
  try{await createModelClient([]).ask('test','json',{},v=>v);throw new Error('不应成功')}
  catch(error){expect(String(error)).toContain('HTTP 401');expect(String(error)).not.toContain('secret-detail');expect(String(error)).not.toContain('test-only-secret')}
 })
 test('音频观察超出片段被拒绝；相对时间转原片绝对时间',()=>{
  expect(()=>parseAudio({observations:[{label:'停顿',startMs:0,endMs:3000,evidence:'停顿',certainty:'clear'}],transcriptCheck:'unknown',issues:[]},5000,6000)).toThrow()
  const result=parseAudio({observations:[{label:'停顿',startMs:100,endMs:300,evidence:'可听停顿',certainty:'uncertain'}],transcriptCheck:'unknown',issues:[]},5000,6000)
  expect(result.observations[0].start).toBe(5100)
 })
 test('真实FFmpeg裁出音频并通过本地SSE协议替身验证音频工具',async()=>{
  const path=join(dir,'sample.wav')
  expect((await run('ffmpeg',['-v','error','-y','-f','lavfi','-i','anullsrc=r=16000:cl=mono','-t','1',path])).code).toBe(0)
  server=Bun.serve({port:0,hostname:'127.0.0.1',async fetch(req){
   const body=await req.json() as any
   expect(body.stream).toBe(true);expect(body.messages[1].content[1].input_audio.data.startsWith('data:;base64,')).toBe(true)
   const content=JSON.stringify({observations:[],transcriptCheck:'unknown',issues:['仅协议测试']})
   return new Response(`data: ${JSON.stringify({choices:[{delta:{content:content.slice(0,20)},finish_reason:null}]})}\n\ndata: ${JSON.stringify({choices:[{delta:{content:content.slice(20)},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`,{headers:{'Content-Type':'text/event-stream'}})
  }})
  process.env.AUDIO_REVIEW_API_KEY='test-only';process.env.AUDIO_REVIEW_MODEL='test-only';process.env.AUDIO_REVIEW_BASE_URL=`http://127.0.0.1:${server.port}`
  const result=await reviewAudio({audioPath:path,start:0,end:1000,original:'原文',chinese:'译文'})
  expect(result.status).toBe('reviewed');expect(result.transcriptCheck).toBe('unknown')
 })
 test('模型协议支持一次格式修复并记录供应商返回用量',async()=>{
  let count=0
  server=Bun.serve({port:0,hostname:'127.0.0.1',fetch:()=>Response.json({choices:[{message:{content:++count===1?'bad-json':'{"ok":true}'},finish_reason:'stop'}],usage:{prompt_tokens:12,completion_tokens:4}})})
  process.env.HIGHLIGHT_API_KEY='test-only';process.env.HIGHLIGHT_BASE_URL=`http://127.0.0.1:${server.port}`
  const calls:HighlightRun['calls']=[]
  const result=await createModelClient(calls).ask('test','json',{},v=>v as {ok:boolean})
  expect(result.ok).toBe(true);expect(count).toBe(2);expect(calls[0].status).toBe('error');expect(calls[1].inputTokens).toBe(12)
 })
})
