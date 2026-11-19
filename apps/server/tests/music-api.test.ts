import {test,expect} from 'bun:test'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
test('音乐API：真实合成库可读取、LLM引用受限与缓存、上传检测、配置范围校验',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'music-api-'))
 const service=join(import.meta.dir,'../src/music/service.ts'),store=join(import.meta.dir,'../src/store.ts')
 const script=`
 const {musicRoutes,resolveBgm}=await import(${JSON.stringify(service)});const {projects,UPLOAD_DIR}=await import(${JSON.stringify(store)});
 const assert=(v,m)=>{if(!v)throw Error(m)};
 const res=await musicRoutes.request('/library'),library=await res.json();assert(library.length===3,'缺少真实素材');
 assert((await Bun.file(UPLOAD_DIR+'/'+library[0].url.split('/').pop()).arrayBuffer()).byteLength>100000,'没有实际音频');
 projects.put({id:'p',transcript:[{id:'a',start:0,end:3000,text:'机器人正在进入工厂'}],duration:3000,fileName:'test.mp4',brand:{channelId:'technology'},clips:[{id:'c',start:0,end:3000,title:'机器人应用',subtitles:[{id:'a',start:0,end:3000,text:'机器人正在进入工厂'}],operations:[],replacements:[],status:'draft'}]});
 let calls=0;const mock=Bun.serve({port:0,hostname:'127.0.0.1',async fetch(req){calls++;const b=await req.json(),m=JSON.parse(b.messages[1].content);assert(m.input.speechRate>0,'未统计语速');return Response.json({choices:[{message:{content:JSON.stringify({suitable:true,mood:'平稳',summary:'科技口播',ranking:m.input.tracks.map(t=>({id:t.id,reason:'无歌词，适合人声'}))})}}]})}});
 process.env.HIGHLIGHT_API_KEY='test';process.env.MUSIC_API_KEY='music-test';process.env.MUSIC_BASE_URL='http://127.0.0.1:'+mock.port;process.env.HIGHLIGHT_BASE_URL='http://127.0.0.1:'+mock.port;
 const r=await musicRoutes.request('/recommend/p/c',{method:'POST'});assert(r.ok,await r.text());
 const cached=await(await musicRoutes.request('/recommend/p/c',{method:'POST'})).json();assert(cached.tracks.length===3&&calls===1,'未缓存或候选不实');
 const settings={enabled:true,trackId:library[0].id,volume:.2,sourceIn:0,start:0,end:3000,fadeIn:100,fadeOut:100,ducking:true};assert(resolveBgm(settings,3000)?.file,'无法解析真实素材');
 let rejected=false;try{resolveBgm({...settings,end:9000},3000)}catch{rejected=true}assert(rejected,'未校验范围');
 const bad=new FormData();bad.append('file',new File(['invalid'],'bad.wav'));assert((await musicRoutes.request('/upload',{method:'POST',body:bad})).status===400,'假音频被接受');
 const data=new FormData();data.append('file',new File([await Bun.file(UPLOAD_DIR+'/'+library[0].url.split('/').pop()).arrayBuffer()],'my-track.wav',{type:'audio/wav'}));const upload=await musicRoutes.request('/upload',{method:'POST',body:data}),track=await upload.json();assert(upload.ok&&track.duration>60000&&track.bpm===0,'上传音频不真实');
 mock.stop(true);console.log('ok');
 `
 try{const child=Bun.spawn(['bun','-e',script],{env:{...process.env,APP_DATA_DIR:dir},stdout:'pipe',stderr:'pipe'});const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);expect({code,err}).toEqual({code:0,err:''});expect(out).toContain('ok')}finally{rmSync(dir,{recursive:true,force:true})}
},15000)
