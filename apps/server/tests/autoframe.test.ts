import { test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCanvas } from '@napi-rs/canvas'
import { run, probe } from '../src/ffmpeg'
test('一键套框真实闭环：窗口检测、字幕标题封面自动生成，仅本批次，保留品牌与画面比例', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'autoframe-')),
    frames = join(dir, 'uploads', 'frames')
  mkdirSync(frames, { recursive: true })
  try {
    const made = await run('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=green:s=160x120:r=30:d=2',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=2',
      '-c:v',
      'libx264',
      '-c:a',
      'aac',
      '-shortest',
      join(dir, 'uploads', 'source.mp4'),
    ])
    expect(made.code).toBe(0)
    const canvas = createCanvas(320, 480),
      ctx = canvas.getContext('2d')
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, 320, 480)
    ctx.clearRect(20, 120, 280, 170)
    writeFileSync(join(frames, 'cover.png'), canvas.toBuffer('image/png'))
    ctx.fillRect(0, 0, 320, 480)
    ctx.clearRect(20, 30, 276, 350)
    writeFileSync(join(frames, 'body.png'), canvas.toBuffer('image/png'))
    const root = join(import.meta.dir, '../src')
    const script = `
 const {projects,templates,exports_}=await import(${JSON.stringify(root + '/store.ts')});const {default:api}=await import(${JSON.stringify(root + '/index.ts')});const assert=(v,m)=>{if(!v)throw Error(m)};
 const t={id:'t',name:'原有品牌',version:1,canvas:{width:320,height:480},videoViewport:{x:20,y:30,width:280,height:350},subtitleSafeArea:{x:20,y:300,width:280,height:100},coverTitleSafeArea:{x:20,y:310,width:280,height:120},coverFrameUrl:'/files/uploads/frames/cover.png',bodyFrameUrl:'/files/uploads/frames/body.png',defaultTransform:{scale:1,offsetX:0,offsetY:0}};templates.put(t);
 const clip=id=>({id,start:0,end:2000,title:'新闻标题',subtitles:[{id:'s',start:0,end:2000,text:'Power matters.'}],replacements:[],operations:[],status:'draft',transform:{scale:1.1,offsetX:8,offsetY:0}});
 projects.put({id:'p',fileName:'source.mp4',width:160,height:120,duration:2000,templateId:'t',activeClipIds:['c'],brand:{channelId:'ai',template:t,confirmedAt:1,revision:1},transcript:[{id:'s',start:0,end:2000,text:'Power matters.'}],translations:[{segmentId:'s',textZh:'电力很重要',status:'reviewed',issues:[]}],clips:[clip('c'),clip('archived')],analysis:{stage:'completed',tasks:[]}});
 const snapshot=JSON.stringify(projects.get('p').brand),archived=JSON.stringify(projects.get('p').clips[1]);let calls=0;
 const mock=Bun.serve({port:0,hostname:'127.0.0.1',async fetch(req){const body=await req.json(),m=JSON.parse(body.messages[1].content);calls++;return Response.json({choices:[{message:{content:JSON.stringify(m.input.tracks?{suitable:true,summary:'科技口播适配',mood:'平稳',ranking:m.input.tracks.map(t=>({id:t.id,reason:'无歌词、节奏适中'}))}:{recommendedIndex:0,recommendationReason:'核心观点',candidates:['新闻热点型','冲突悬念型','犀利观点型','行业趋势型','深度洞察型'].map((angle,i)=>({title:'电力与技术发展'+i,angle,evidenceIds:m.input.segments.map(s=>s.id)}))})},finish_reason:'stop'}]})}});
 process.env.HIGHLIGHT_BASE_URL='http://127.0.0.1:'+mock.port;process.env.HIGHLIGHT_API_KEY='test';process.env.MUSIC_API_KEY='music-test';process.env.MUSIC_BASE_URL='http://127.0.0.1:'+mock.port;process.env.DEEPSEEK_BASE_URL=process.env.HIGHLIGHT_BASE_URL;process.env.DEEPSEEK_API_KEY='deepseek-test';
 const call=(path,method='GET')=>api.fetch(new Request('http://localhost'+path,{method}));
 const response=await call('/api/projects/p/autoframe','POST');assert(response.status===200,'未启动');
 const duplicate=await call('/api/projects/p/autoframe','POST');assert((await duplicate.json()).jobId===(await response.json()).jobId,'重复创建任务');
 let p;for(let i=0;i<500;i++){p=await(await call('/api/projects/p')).json();if(['completed','failed'].includes(p.autoFrameRun.status))break;await Bun.sleep(40)}
 assert(p.autoFrameRun.status==='completed',p.autoFrameRun.message);const c=p.clips[0];assert(p.clips.length===1&&c.packaging.candidates.length===5&&c.cover.imageUrl,'包装缺失');assert(c.packaging.frameLayout.fit==='cover','不是等比适配');assert(c.packaging.coverStyle.y>.6,'封面标题不在画面下方');assert(c.packaging.bodyStyle.y<c.packaging.subtitleStyle.y,'标题字幕位置错误');assert(c.transform.scale===1.1&&c.transform.offsetX===8,'已有构图被重置');assert(JSON.stringify(projects.get('p').brand)===snapshot,'原包框被改动');assert(JSON.stringify(projects.get('p').clips[1])===archived,'未选片段被处理');
 const j=exports_.get(p.autoFrameRun.previewJobIds[0]);assert(j.status==='completed'&&j.coverUrl&&j.fileUrl,'真实预览缺失');assert(calls===2,'应只调用一次标题和一次音乐推荐');assert(c.packaging.bgm?.enabled&&c.packaging.bgm.ducking,'自动配乐未应用');
 const {editClip}=await import(${JSON.stringify(join(import.meta.dir,'../src/editing/service.ts'))});const broken=structuredClone(c.packaging);broken.frameLayout.fit='contain';broken.frameLayout.bodyViewport={x:0,y:0,width:320,height:480};editClip('p','c',{type:'presentation',packaging:broken,transform:{scale:1,offsetX:0,offsetY:0}});
 const restoredResponse=await call('/api/projects/p/restore-framing','POST');assert(restoredResponse.status===200,'恢复接口失败');const restored=(await restoredResponse.json()).clips[0];assert(restored.packaging.frameLayout.fit==='cover'&&restored.packaging.frameLayout.bodyViewport.x===t.videoViewport.x,'未恢复模板窗口');assert(restored.transform.scale===1.1&&restored.transform.offsetX===8,'未从历史恢复构图');
 mock.stop(true);console.log('RESULT:'+JSON.stringify({file:j.fileUrl,cover:j.coverUrl}));`
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
    const result = JSON.parse(out.split('RESULT:')[1])
    const video = join(dir, 'outputs', result.file.split('/').pop())
    const info = await probe(video)
    expect(info.hasAudio).toBe(true)
    expect(Math.abs(info.duration - 2000)).toBeLessThan(150)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}, 30000)

test('等比例完整适配：横画面放入竖框仍保留两侧边缘，封面图片不拉伸', async () => {
  const { renderClip } = await import('../src/ffmpeg'),
    { composeCover } = await import('../src/subtitles'),
    { loadImage } = await import('@napi-rs/canvas')
  const dir = mkdtempSync(join(tmpdir(), 'contain-proof-'))
  try {
    const input = join(dir, 'source.mp4'),
      out = join(dir, 'out.mp4')
    expect(
      (
        await run('ffmpeg', [
          '-v',
          'error',
          '-y',
          '-f',
          'lavfi',
          '-i',
          'color=green:s=160x80:r=30:d=1,drawbox=x=0:y=0:w=20:h=80:c=red:t=fill,drawbox=x=140:y=0:w=20:h=80:c=blue:t=fill',
          '-c:v',
          'libx264',
          input,
        ])
      ).code,
    ).toBe(0)
    expect(
      (
        await renderClip({
          input,
          output: out,
          startMs: 0,
          endMs: 1000,
          canvasW: 200,
          canvasH: 240,
          viewport: { x: 20, y: 20, width: 160, height: 200 },
          fit: 'contain',
        })
      ).ok,
    ).toBe(true)
    const pixel = async (x: number, y: number) => {
      const p = Bun.spawn(
        [
          'ffmpeg',
          '-v',
          'error',
          '-ss',
          '0.3',
          '-i',
          out,
          '-frames:v',
          '1',
          '-vf',
          `crop=2:2:${x}:${y},scale=1:1`,
          '-pix_fmt',
          'rgb24',
          '-f',
          'rawvideo',
          'pipe:1',
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      )
      const bytes = await new Response(p.stdout).arrayBuffer()
      await p.exited
      return [...new Uint8Array(bytes)]
    }
    expect((await pixel(30, 110))[0]).toBeGreaterThan(200)
    expect((await pixel(170, 110))[2]).toBeGreaterThan(200)
    expect((await pixel(100, 30)).some((v) => v > 30)).toBe(true) // blurred source fills unused area
    const bg = createCanvas(160, 80),
      b = bg.getContext('2d')
    b.fillStyle = 'red'
    b.fillRect(0, 0, 160, 80)
    const path = join(dir, 'bg.png')
    writeFileSync(path, bg.toBuffer('image/png'))
    const blank = join(dir, 'title.png')
    writeFileSync(blank, createCanvas(200, 240).toBuffer('image/png'))
    const cover = join(dir, 'cover.jpg')
    await composeCover(path, blank, null, cover, 200, 240, { x: 20, y: 20, width: 160, height: 200 })
    const c = createCanvas(200, 240),
      ctx = c.getContext('2d')
    ctx.drawImage(await loadImage(cover), 0, 0)
    expect(ctx.getImageData(100, 30, 1, 1).data[0]).toBeGreaterThan(200) // cover padding uses source background
    expect(ctx.getImageData(100, 100, 1, 1).data[0]).toBeGreaterThan(200)
    const titleCanvas=createCanvas(200,240),titleCtx=titleCanvas.getContext('2d');titleCtx.fillStyle='white';titleCtx.fillRect(90,200,20,20);writeFileSync(blank,titleCanvas.toBuffer('image/png'))
    const opaque=join(dir,'opaque.png'),frameCanvas=createCanvas(200,240),frameCtx=frameCanvas.getContext('2d');frameCtx.fillStyle='black';frameCtx.fillRect(0,0,200,240);writeFileSync(opaque,frameCanvas.toBuffer('image/png'))
    await composeCover(path,blank,opaque,cover,200,240,{x:20,y:20,width:160,height:160});ctx.drawImage(await loadImage(cover),0,0);expect(ctx.getImageData(100,210,1,1).data[0]).toBeGreaterThan(200)

  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}, 15000)
