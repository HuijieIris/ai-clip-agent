import {test,expect} from 'bun:test'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
test('本次选择隔离：四选六只展示四条，历史保留，重选编辑过的片段不重复创建',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'active-clips-')),root=join(import.meta.dir,'../src')
 const script=`
 const {projects}=await import(${JSON.stringify(root+'/store.ts')});const {default:api}=await import(${JSON.stringify(root+'/index.ts')});const {editClip}=await import(${JSON.stringify(root+'/editing/service.ts')});const assert=(v,m)=>{if(!v)throw Error(m)};
 const hs=Array.from({length:6},(_,i)=>({id:'h'+i,title:'高光'+i,start:i*4000,end:i*4000+2000,score:90-i,reason:'理由',transcript:'原文',tags:[],status:'draft'}));
 projects.put({id:'p',duration:30000,fileName:'source.mp4',transcript:[],highlights:hs,clips:hs.map((h,i)=>({...h,id:'c'+i,highlightId:h.id,subtitles:[],replacements:[],operations:[],selected:true})),analysis:{stage:'completed',tasks:[]}});
 const call=(path,body)=>api.fetch(new Request('http://localhost/api/projects/p'+path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{}));
 let r=await call('/clips',{highlightIds:['h0','h1','h2','h3']});assert(r.status===200,'创建失败');assert((await r.json()).clips.length===4,'返回数量不符');
 let p=await(await call('')).json();assert(p.clips.length===4&&p.activeClipIds.length===4,'界面仍显示六条');assert(projects.get('p').clips.length===6,'历史被删除');
 await call('/clips',{highlightIds:['h5']});editClip('p','c5',{type:'metadata',title:'人工改过标题'});editClip('p','c5',{type:'trim',start:21000,end:23000});
 r=await call('/clips',{highlightIds:['h5']});const selected=(await r.json()).clips;assert(selected.length===1&&selected[0].id==='c5'&&selected[0].title==='人工改过标题'&&selected[0].start===21000,'重选丢失编辑或重复创建');
 editClip('p','c5',{type:'undo'});assert(projects.get('p').clips.find(c=>c.id==='c5').highlightId==='h5','撤销丢失高光关联');
 await call('/clips',{highlightIds:['h3','h0']});p=await(await call('')).json();assert(p.clips.map(c=>c.id).join(',')==='c3,c0','批次顺序错误');assert(projects.get('p').clips.length===6,'历史数量变化');
 assert((await call('/clips',{highlightIds:['missing']})).status===400,'无效高光未拒绝');assert(projects.get('p').activeClipIds.join(',')==='c3,c0','错误请求污染批次');
 console.log('ACTIVE_OK');`
 try{const child=Bun.spawn([process.execPath,'-e',script],{env:{...process.env,APP_DATA_DIR:dir},stdout:'pipe',stderr:'pipe'});const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);expect({code,err}).toEqual({code:0,err:''});expect(out).toContain('ACTIVE_OK')}finally{rmSync(dir,{recursive:true,force:true})}
})
