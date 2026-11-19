import { test, expect } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chineseOutput, defaultTextStyle, packagingNeedsReview } from '../../../packages/shared/packaging'
import { renderCuePng, renderTitlePng } from '../src/subtitles'
import { createCanvas, loadImage } from '@napi-rs/canvas'

test('中文分屏保留源区间，内部删除后时间重新累计，不覆盖源文本', () => {
  const p: any = {
    sourceCues: [
      { id: 's1', start: 0, end: 4000, text: '第一屏中文\n第二屏中文', original: 'original' },
      { id: 's2', start: 6000, end: 8000, text: '最后一句', original: 'last' },
    ],
  }
  const plan: any = {
    spans: [
      { id: 'a', sourceIn: 0, sourceOut: 4000 },
      { id: 'b', sourceIn: 6000, sourceOut: 8000 },
    ],
  }
  const out = chineseOutput(p, plan)
  expect(out.map((c) => [c.start, c.end])).toEqual([
    [0, 2000],
    [2000, 4000],
    [4000, 6000],
  ])
  expect(p.sourceCues[0].original).toBe('original')
  expect(packagingNeedsReview({sourceCues:[{status:'needs_review',start:4000,end:6000}]} as any,plan)).toBe(false)
})
test('真实文字栅格：手动换行、高亮、正文标题可见，出界明确报错', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chinese-layers-'))
  try {
    const style = {
      ...defaultTextStyle(28),
      y: 0.55,
      width: 0.8,
      highlightColor: '#FFFF00',
      background: false,
    }
    const path = join(dir, 'sub.png')
    expect(
      renderCuePng('保留安全\n中文表达', 320, 480, path, { style, sourceW: 320, highlights: ['安全'] }),
    ).toBe(true)
    const canvas = createCanvas(320, 480),
      ctx = canvas.getContext('2d')
    ctx.drawImage(await loadImage(path), 0, 0)
    const data = ctx.getImageData(0, 0, 320, 480).data
    let yellow = 0,
      white = 0
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 180 && data[i + 1] > 180 && data[i + 2] < 80 && data[i + 3] > 100) yellow++
      if (data[i] > 180 && data[i + 1] > 180 && data[i + 2] > 180 && data[i + 3] > 100) white++
    }
    expect(yellow).toBeGreaterThan(20)
    expect(white).toBeGreaterThan(20)
    expect(() =>
      renderCuePng('第一行\n第二行\n第三行', 320, 480, join(dir, 'bad.png'), { style, sourceW: 320 }),
    ).toThrow('两行')
    const title = join(dir, 'title.png')
    renderTitlePng('中文标题', 320, 480, title, { ...style, y: 0.1 }, 320)
    expect(readFileSync(title).length).toBeGreaterThan(100)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('中文包装API闭环：复用翻译、五组真实协议候选、手工锁定、版本冲突、批量隔离、英文导出拦截', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'packaging-api-')),
    entry = join(import.meta.dir, '../src/index.ts'),
    store = join(import.meta.dir, '../src/store.ts'),
    edit = join(import.meta.dir, '../src/editing/service.ts')
  const script = `
 const {projects,templates}=await import(${JSON.stringify(store)});
 const {editClip,viewClip}=await import(${JSON.stringify(edit)});
 const {default:api}=await import(${JSON.stringify(entry)});
 const assert=(v,m)=>{if(!v)throw Error(m)};
 const t={id:'t',name:'原模板',version:1,channelIds:[],canvas:{width:320,height:480},videoViewport:{x:10,y:80,width:300,height:240},subtitleSafeArea:{x:10,y:350,width:300,height:100},coverTitleSafeArea:{x:10,y:300,width:300,height:100},coverFrameUrl:'/files/uploads/frames/cover.png',bodyFrameUrl:'/files/uploads/frames/body.png',defaultTransform:{scale:1,offsetX:0,offsetY:0}};templates.put(t);
 const make=id=>({id,start:0,end:4000,title:'原有标题',subtitles:[{id:'a',start:0,end:2000,text:'Safety matters.'},{id:'b',start:2000,end:4000,text:'Progress matters too.'}],replacements:[],operations:[],status:'draft'});
 projects.put({id:'p',fileName:'test.mp4',duration:4000,templateId:'t',targetRatio:'9:16',brand:{channelId:'ai',template:t,confirmedAt:1,revision:1},transcript:[{id:'a',start:0,end:2000,text:'Safety matters.'},{id:'b',start:2000,end:4000,text:'Progress matters too.'}],translations:[{segmentId:'a',textZh:'安全很重要。',status:'reviewed',issues:[]},{segmentId:'b',textZh:'技术进步也很重要。',status:'reviewed',issues:[]}],clips:[make('c1'),make('c2')],analysis:{stage:'completed',tasks:[]}});
 let titleCalls=0,translateCalls=0,mode='ok';
 const mock=Bun.serve({port:0,hostname:'127.0.0.1',async fetch(req){const b=await req.json(),m=JSON.parse(b.messages[1].content);let value;
 if(m.task.includes('recommendedIndex')){titleCalls++;if(mode==='error')return new Response('upstream',{status:503});value={recommendedIndex:1,recommendationReason:'事实完整',candidates:['新闻热点型','冲突悬念型','犀利观点型','行业趋势型','深度洞察型'].map((angle,i)=>({title:'安全与技术进步如何兼顾'+i,angle,evidenceIds:m.input.segments.map(s=>s.id)}))}}
 else{translateCalls++;value={items:m.input.segments.map(s=>({segmentId:s.id,textZh:'补译后的中文内容',...(m.input.translations||m.task.includes('校对中文字幕')?{status:'reviewed',issues:[]}:{})}))}}
 return Response.json({choices:[{message:{content:JSON.stringify(value)},finish_reason:'stop'}]})}});
 process.env.HIGHLIGHT_BASE_URL='http://127.0.0.1:'+mock.port;process.env.HIGHLIGHT_API_KEY='test-only';process.env.DEEPSEEK_BASE_URL=process.env.HIGHLIGHT_BASE_URL;process.env.DEEPSEEK_API_KEY='deepseek-test';
 const call=(path,body)=>api.fetch(new Request('http://localhost'+path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{}));
 const exportsBody={clipIds:['c1'],ratio:'9:16',resolution:'720P',withSubtitles:true,exportCover:false};
 assert((await call('/api/projects/p/export',exportsBody)).status===400,'英文可直接烧录');
 const run=async(body)=>{const r=await call('/api/projects/p/packaging',body);assert(r.status===200,'包装启动失败');const j=await r.json();for(let i=0;i<200;i++){const x=await(await call('/api/packaging/'+j.id)).json();if(['completed','failed'].includes(x.status))return x;await Bun.sleep(10)}throw Error('timeout')};
 const result=await run({clipIds:['c1']});assert(result.status==='completed',result.message);assert(titleCalls===1&&translateCalls===0,'没有复用原译文');
 const prepResponse=await call('/api/projects/p/clips/c1/subtitles/prepare',{});assert(prepResponse.status===200,'字幕准备启动失败');const prep=await prepResponse.json();for(let i=0;i<200;i++){const j=await(await call('/api/packaging/'+prep.id)).json();if(j.status==='completed')break;if(j.status==='failed')throw Error(j.message);await Bun.sleep(10)}assert(titleCalls===1,'字幕准备重复生成标题');
 const modeResponse=await call('/api/projects/p/clips/c1/ops',{type:'subtitle_mode',mode:'en'});assert(modeResponse.status===200&&(await modeResponse.json()).clip.subtitleMode==='en','语种未保存');
 let c=viewClip(projects.get('p'),projects.get('p').clips[0]);assert(c.packaging.subtitleStyle.outlineWidth===15&&!c.packaging.subtitleStyle.background,'描边或背景未保存');
assert(c.packaging.candidates.length===5,'没有五组');assert(c.packaging.coverTitle.includes('兼顾'),'没有应用AI封面');assert(c.subtitles[0].text==='Safety matters.','原字幕被覆盖');
 const originalBrand=JSON.stringify(projects.get('p').brand),oldCandidates=JSON.stringify(c.packaging.candidates);
 c.packaging.coverTitle=c.packaging.bodyTitle='我手工修改的封面';c.packaging.coverLocked=true;c.packaging.sourceCues[0].text='我校对后的中文';c.packaging.sourceCues[0].highlights=[];c.packaging.sourceCues[0].locked=true;c.packaging.sourceCues[0].status='manual';
 const save=await call('/api/projects/p/clips/c1/presentation',{packaging:c.packaging,expectedRevision:c.editPlan.revision});assert(save.status===200,'保存失败');
 assert((await call('/api/projects/p/clips/c1/presentation',{packaging:c.packaging,expectedRevision:0})).status===409,'未拦截旧版本');
 assert((await run({clipIds:['c1']})).status==='completed','重生成失败');c=viewClip(projects.get('p'),projects.get('p').clips[0]);assert(c.packaging.coverTitle==='我手工修改的封面'&&c.packaging.sourceCues[0].text==='我校对后的中文','手工内容被覆盖');
 const before=JSON.stringify(c.packaging);editClip('p','c1',{type:'packaging',packaging:{...c.packaging,coverTitle:'测试新正文',bodyTitle:'测试新正文'}});const undone=editClip('p','c1',{type:'undo'});assert(JSON.stringify(undone.packaging)===before,'包装无法精确撤销');
 const styles={coverStyle:c.packaging.coverStyle,bodyStyle:c.packaging.bodyStyle,subtitleStyle:c.packaging.subtitleStyle,expectedRevision:undone.editPlan.revision};
 const batch=await call('/api/projects/p/clips/c1/packaging-style',styles);assert(batch.status===200,'批量失败');const p=await batch.json();assert(p.clips[1].packaging.coverTitle==='原有标题','批量复制了文本');assert(JSON.stringify(projects.get('p').brand)===originalBrand,'原品牌被修改');
 c=viewClip(projects.get('p'),projects.get('p').clips[0]);const layer=await call('/api/projects/p/clips/c1/text-preview',{packaging:{...c.packaging,coverStyle:{...c.packaging.coverStyle,fontSize:18},bodyStyle:{...c.packaging.bodyStyle,fontSize:18},subtitleStyle:{...c.packaging.subtitleStyle,fontSize:18}},time:0});assert(layer.status===200,'文字预览失败');const urls=await layer.json();assert(urls.body&&urls.cover&&urls.subtitle,'文字层缺失');
 mode='error';const failed=await run({clipIds:['c1']});assert(failed.status==='failed'&&failed.message.includes('503'),'上游错误未反馈');assert(projects.get('p').clips[0].packaging.coverTitle==='我手工修改的封面','失败破坏内容');
 mode='ok';const fresh=projects.get('p');fresh.translations=[];fresh.clips[1].editPlan.sourceSubtitles=fresh.clips[1].editPlan.sourceSubtitles.map((s,i)=>({...s,id:'fresh_'+i,text:'A new statement about future technology '+i}));projects.put(fresh);const translated=await run({clipIds:['c2']});assert(translated.status==='completed'&&translateCalls>0,'缺失译文没有真实协议补译:'+JSON.stringify({translated,translateCalls}));
 const cn=projects.get('p');cn.clips[1].editPlan.sourceSubtitles=cn.clips[1].editPlan.sourceSubtitles.map((s,i)=>({...s,id:'zh_'+i,text:'中文原始字幕'+i}));cn.clips[1].packaging.sourceCues=[];projects.put(cn);const proof=await run({clipIds:['c2']});assert(proof.status==='completed'&&proof.calls.some(c=>c.stage==='packaging_proofread'),'中文校对未执行');
 mock.stop(true);console.log('PACKAGING_OK');`
  try {
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
    expect(out).toContain('PACKAGING_OK')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}, 15000)
