import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

test('API 集成：独立数据目录中复用逐字稿推荐、无候选完成、取消与错误反馈，不改现有项目',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'highlight-api-'))
 const entry=join(import.meta.dir,'../src/index.ts'),store=join(import.meta.dir,'../src/store.ts')
 const script=`
 const {default:api}=await import(${JSON.stringify(entry)});
 const {projects}=await import(${JSON.stringify(store)});
 const assert=(value,message)=>{if(!value)throw new Error(message)};
 const fixture={id:'integration-only',title:'integration-only',fileName:'not-needed.mp4',sourceUrl:null,duration:40000,width:1920,height:1080,sizeBytes:1,templateId:null,targetRatio:'fit',minDuration:20000,maxDuration:45000,desiredCount:3,analysis:{stage:'queued',tasks:[]},transcript:[{id:'s1',start:0,end:20000,text:'测试用已有原文第一段。'},{id:'s2',start:20000,end:40000,text:'测试用已有原文第二段。'}],highlights:[],clips:[{id:'existing-clip',start:0,end:20000,title:'existing',subtitles:[],replacements:[],operations:[],status:'draft'}],createdAt:Date.now(),updatedAt:Date.now()};
 projects.put(fixture);
 const call=(path,body)=>api.fetch(new Request('http://localhost/api/projects/integration-only'+path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}));
 const bad=await call('/recommend',{searchMode:'bad'});assert(bad.status===400,'配置错误未拒绝');
 let mode='ok';
 const mock=Bun.serve({port:0,hostname:'127.0.0.1',async fetch(req){
 const body=await req.json();if(mode==='wait')await Bun.sleep(300);
 if(mode==='error')return new Response('upstream unavailable',{status:503});
 return Response.json({choices:[{message:{content:JSON.stringify({topics:[],candidates:[],queries:[]})},finish_reason:'stop'}]});
 }});
 process.env.HIGHLIGHT_BASE_URL='http://127.0.0.1:'+mock.port;process.env.HIGHLIGHT_API_KEY='test-only';
 const settle=async()=>{for(let i=0;i<200;i++){const p=await(await call('')).json();if(['completed','failed','cancelled'].includes(p.analysis.stage))return p;await Bun.sleep(10)}throw new Error('任务未结束')};
 assert((await call('/recommend',{searchMode:'off'})).status===200,'未启动');
 let p=await settle();assert(p.analysis.stage==='completed','空候选未正常完成');assert(p.highlightRun.status==='completed','运行状态未保存');assert(p.transcript.length===2&&p.clips[0].id==='existing-clip','已有原文或剪辑被覆盖');
 mode='error';await call('/recommend',{});p=await settle();assert(p.analysis.stage==='failed'&&p.analysis.error.includes('503'),'模型错误未反馈');assert(p.highlightHistory.length===1,'旧批次未保留');
 mode='wait';await call('/recommend',{});assert((await call('/recommend',{})).status===409,'并发任务未拒绝');await call('/analyze/cancel',{});await Bun.sleep(100);p=await settle();assert(p.analysis.stage==='cancelled','取消被覆盖');
 mock.stop(true);console.log('INTEGRATION_OK');
 `
 try{
  const child=Bun.spawn([process.execPath,'-e',script],{env:{...process.env,APP_DATA_DIR:dir,HIGHLIGHT_API_KEY:'',OPENAI_API_KEY:'',TAVILY_API_KEY:'',AUDIO_REVIEW_API_KEY:''},stdout:'pipe',stderr:'pipe'})
  const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])
  expect({code,err}).toEqual({code:0,err:''});expect(out).toContain('INTEGRATION_OK')
 }finally{rmSync(dir,{recursive:true,force:true})}
},10000)
