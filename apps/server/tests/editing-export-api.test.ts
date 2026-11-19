import { test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createCanvas } from '@napi-rs/canvas'
import { run, probe } from '../src/ffmpeg'

test('真实导出API：代理和正式成片复用快照，编辑后旧任务不变、素材缺失明确失败', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'edit-export-api-'))
  try {
    const uploads = join(dir, 'uploads'),
      frames = join(uploads, 'frames')
    mkdirSync(frames, { recursive: true })
    const made = await run('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=160x120:r=30:d=3',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=3',
      '-c:v',
      'libx264',
      '-c:a',
      'aac',
      '-shortest',
      join(uploads, 'test.mp4'),
    ])
    expect(made.code).toBe(0)
    const canvas = createCanvas(320, 480),
      ctx = canvas.getContext('2d')
    ctx.fillStyle = 'red'
    ctx.fillRect(0, 0, 320, 30)
    writeFileSync(join(frames, 'body.png'), canvas.toBuffer('image/png'))
    ctx.fillStyle = 'blue'
    ctx.fillRect(0, 0, 320, 30)
    writeFileSync(join(frames, 'cover.png'), canvas.toBuffer('image/png'))
    const entry = join(import.meta.dir, '../src/index.ts'),
      store = join(import.meta.dir, '../src/store.ts'),
      edit = join(import.meta.dir, '../src/editing/service.ts')
    const script = `
 const {projects,templates,exports_}=await import(${JSON.stringify(store)});
 const {editClip,viewClip}=await import(${JSON.stringify(edit)});
 const {default:api}=await import(${JSON.stringify(entry)});
 const assert=(v,m)=>{if(!v)throw Error(m)};
 const t={id:'t',name:'频道模板',version:1,channelIds:[],canvas:{width:320,height:480},videoViewport:{x:0,y:80,width:320,height:240},subtitleSafeArea:{x:10,y:330,width:300,height:100},coverTitleSafeArea:{x:10,y:30,width:300,height:50},coverFrameUrl:'/files/uploads/frames/cover.png',bodyFrameUrl:'/files/uploads/frames/body.png',defaultTransform:{scale:1,offsetX:0,offsetY:0}};templates.put(t);
 const c={id:'c',start:0,end:3000,title:'导出验证',subtitles:[{id:'s1',start:0,end:1000,text:'First statement about power.'},{id:'s2',start:1000,end:2000,text:'Second statement about power.'},{id:'s3',start:2000,end:3000,text:'Third statement about power.'}],replacements:[],operations:[],status:'draft'};
 projects.put({id:'p',title:'测试',fileName:'test.mp4',duration:3000,templateId:'t',targetRatio:'9:16',brand:{channelId:'ai',template:t,confirmedAt:Date.now(),revision:1},transcript:[],clips:[c],analysis:{stage:'completed',tasks:[]}});
 editClip('p','c',{type:'delete_range',start:1000,end:2000});
 const current=viewClip(projects.get('p'),projects.get('p').clips[0]);
 const {defaults}=await import(${JSON.stringify(join(import.meta.dir, '../src/packaging/service.ts'))});
 const pack=defaults(current,t,'ai');pack.coverTitle='测试封面中文';pack.bodyTitle='视频内部中文标题';pack.bodyMode='intro';pack.bodyIntroMs=1000;
 for(const style of [pack.coverStyle,pack.bodyStyle,pack.subtitleStyle])style.fontSize=18;
 pack.sourceCues=current.editPlan.sourceSubtitles.map(c=>({id:c.id,start:c.start,end:c.end,original:c.text,text:'原声对应中文字幕',status:'reviewed',issues:[],highlights:['中文'],locked:false}));
 editClip('p','c',{type:'packaging',packaging:pack});

 const call=(path,body)=>api.fetch(new Request('http://localhost'+path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{}));
 assert((await call('/files/app.sqlite')).status===404,'数据库可被下载');assert((await call('/files/backups/x')).status===404,'备份暴露');assert((await call('/files/uploads/%2e%2e%2fapp.sqlite')).status===404,'编码路径绕过限制');
 const body={clipIds:['c'],ratio:'9:16',resolution:'720P',withSubtitles:true,exportCover:true};
 const response=await call('/api/projects/p/export',{...body,preview:true});assert(response.status===200,'预览创建失败');const preview=(await response.json()).jobs[0];
 const response2=await call('/api/projects/p/export',body);const final=(await response2.json()).jobs[0];
 assert(preview.renderSnapshot.clip.editPlan.durationMs===2000,'任务不是冻结编辑版本');
 editClip('p','c',{type:'trim',start:0,end:1000});templates.put({...t,name:'下一版',version:2});
 const settle=async(id)=>{for(let i=0;i<300;i++){const j=exports_.get(id);if(j.status==='completed'||j.status==='failed')return j;await Bun.sleep(50)}throw Error('render timeout')};
 const a=await settle(preview.id),b=await settle(final.id);assert(a.status==='completed',a.message);assert(b.status==='completed',b.message);assert(a.editRevision===2&&b.editRevision===2,'渲染版本错误');
 assert(a.renderSnapshot.template.version===1,'模板快照被修改');assert((await call('/api/exports/'+b.id+'/retry',{})).status===409,'完成任务可重复入队');
 editClip('p','c',{type:'replace',replacement:{start:0,end:1000,assetUrl:'/files/uploads/frames/missing.png',assetId:'missing',assetName:'缺失'}});
 const missing=(await(await call('/api/projects/p/export',body)).json()).jobs[0];assert((await settle(missing.id)).status==='failed','缺素材没有失败');
 console.log('RESULT:'+JSON.stringify({preview:a.fileUrl,final:b.fileUrl}));`
    const child = Bun.spawn([process.execPath, '-e', script], {
      env: { ...process.env, APP_DATA_DIR: dir },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect({ code, err }).toEqual({ code: 0, err: '' })
    const result = JSON.parse(out.split('RESULT:')[1].trim())
    for (const url of [result.preview, result.final]) {
      const info = await probe(join(dir, 'outputs', url.split('/').pop()))
      expect(Math.abs(info.duration - 2000)).toBeLessThan(150)
      expect(info.hasAudio).toBe(true)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}, 30000)
