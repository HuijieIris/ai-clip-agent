import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStorage } from '../src/storage'
import { timeMap, outputToSource, sourceToOutput, mapInterval } from '../../../packages/shared/editing'

test('SQLite迁移保留ID与文件路径、备份原件、重启不重复导入、跨连接与回滚', () => {
  const dir = mkdtempSync(join(tmpdir(), 'editing-db-'))
  try {
    const raw = JSON.stringify([{ id: 'p1', fileName: 'old.mp4', clips: [{ id: 'c1' }] }])
    writeFileSync(join(dir, 'projects.json'), raw)
    const db = openStorage(dir)
    const report = db.migration()
    expect(readFileSync(join(report.backup, 'projects.json'), 'utf8')).toBe(raw)
    expect(db.get('projects', 'p1')).toEqual(JSON.parse(raw)[0])
    expect(existsSync(join(report.backup, 'manifest.json'))).toBe(true)
    db.put('projects', { id: 'p2', fileName: 'new.mp4' })
    expect(() =>
      db.transaction(() => {
        db.put('projects', { id: 'rollback' })
        throw Error('abort')
      }),
    ).toThrow('abort')
    expect(db.get('projects', 'rollback')).toBeUndefined()
    const other = openStorage(dir)
    expect(other.get('projects', 'p2')).toEqual({ id: 'p2', fileName: 'new.mp4' })
    other.close()
    db.close()
    const reopened = openStorage(dir)
    expect(reopened.all('projects')).toHaveLength(2)
    reopened.close()
    expect(readFileSync(join(dir, 'projects.json'), 'utf8')).toBe(raw)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('损坏JSON停止迁移，修复后可重新导入，不吞掉原文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'editing-bad-'))
  try {
    writeFileSync(join(dir, 'projects.json'), 'bad')
    expect(() => openStorage(dir)).toThrow()
    expect(readFileSync(join(dir, 'projects.json'), 'utf8')).toBe('bad')
    writeFileSync(join(dir, 'projects.json'), '[{"id":"ok"}]')
    const db = openStorage(dir)
    expect(db.get('projects', 'ok')).toEqual({ id: 'ok' })
    db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('源片与成片边界映射和跨删除段的素材映射', () => {
  const spans = [
    { id: 'a', sourceIn: 1000, sourceOut: 3000 },
    { id: 'b', sourceIn: 5000, sourceOut: 8000 },
  ]
  expect(timeMap(spans).at(-1)?.outputOut).toBe(5000)
  expect(outputToSource(spans, 2000)).toBe(5000)
  expect(outputToSource(spans, 5000)).toBe(8000)
  expect(sourceToOutput(spans, 4000)).toBeNull()
  expect(sourceToOutput(spans, 6000)).toBe(3000)
  expect(mapInterval(spans, 2000, 6000).map((m) => [m.start, m.end])).toEqual([
    [1000, 2000],
    [2000, 3000],
  ])
})
test('真实编辑服务：内删同步映射、精确撤销重做、版本冲突、模板快照与批量事务', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'editing-service-'))
  const entry = join(import.meta.dir, '../src/index.ts'),
    store = join(import.meta.dir, '../src/store.ts'),
    service = join(import.meta.dir, '../src/editing/service.ts'),
    brand = join(import.meta.dir, '../src/branding/service.ts')
  const script = `
 const {projects,templates,transaction}=await import(${JSON.stringify(store)});
 const {editClip,viewClip}=await import(${JSON.stringify(service)});
 const {bindBrand}=await import(${JSON.stringify(brand)});
 const {default:api}=await import(${JSON.stringify(entry)});
 const assert=(v,m)=>{if(!v)throw Error(m)};
 const t={id:'t',name:'AI模板',channelIds:['ai'],version:1,canvas:{width:320,height:480},videoViewport:{x:0,y:80,width:320,height:240},subtitleSafeArea:{x:10,y:330,width:300,height:100},coverTitleSafeArea:{x:10,y:10,width:300,height:70},coverFrameUrl:'/files/uploads/frames/c.png',bodyFrameUrl:'/files/uploads/frames/b.png',defaultTransform:{scale:1,offsetX:0,offsetY:0}};templates.put(t);
 const c={id:'c',start:0,end:6000,title:'测试',subtitles:[{id:'s1',start:0,end:2000,text:'一'},{id:'s2',start:2000,end:4000,text:'二'},{id:'s3',start:4000,end:6000,text:'三'}],replacements:[{id:'r',start:1000,end:5000,assetId:'a',assetName:'图',assetUrl:'/files/uploads/frames/a.png',keepAudio:true}],operations:[],status:'draft'};
 projects.put({id:'p',fileName:'test.mp4',duration:6000,templateId:'t',transcript:[],clips:[c],analysis:{stage:'completed',tasks:[]}});
 bindBrand('p',{channelId:'ai',templateId:'t',confirmed:true});templates.put({...t,name:'已修改',version:2});assert(projects.get('p').brand.template.name==='AI模板','模板快照污染');
 const before=viewClip(projects.get('p'),c);
 let next=editClip('p','c',{type:'delete_range',start:2000,end:4000,expectedRevision:0});
 assert(next.editPlan.durationMs===4000&&next.subtitles.map(x=>x.text).join('')==='一三','字幕未重映射');
 assert(next.replacements.length===2&&next.replacements[1].start===2000&&next.replacements[1].assetIn===3000,'素材源偏移错误');
 const restored=editClip('p','c',{type:'undo',expectedRevision:1});assert(JSON.stringify(restored.subtitles)===JSON.stringify(before.subtitles),'字幕未精确恢复');assert(JSON.stringify(restored.replacements)===JSON.stringify(before.replacements),'素材未精确恢复');
 next=editClip('p','c',{type:'redo',expectedRevision:2});assert(next.editPlan.durationMs===4000,'重做错误');
 let conflict=false;try{editClip('p','c',{type:'subtitle',cueId:next.subtitles[0].id,text:'新',expectedRevision:1})}catch(e){conflict=e.status===409}assert(conflict,'未检测版本冲突');
 let refused=false;try{editClip('p','c',{type:'delete_range',start:500,end:1000})}catch(e){refused=e.message.includes('字幕')}assert(refused,'未阻止无对齐的半句删除');
 const rev=next.editPlan.revision;try{transaction(()=>{editClip('p','c',{type:'metadata',title:'不应保存'});throw Error('rollback')})}catch{}assert(projects.get('p').clips[0].editPlan.revision===rev,'批量回滚失败');
 const call=(path,method='GET',body)=>api.fetch(new Request('http://localhost'+path,{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}));
 assert((await call('/api/projects/p')).status===200,'项目API失败');
 assert((await call('/api/projects/p/brand','PATCH',{channelId:'finance',templateId:'t',confirmed:true})).status===400,'频道不匹配未拦截');
 assert((await call('/api/projects/p/clips/c/ops','POST',{type:'undo',expectedRevision:999})).status===409,'API冲突未反馈');
 const create=await call('/api/projects','POST',{fileName:'test.mp4',originalName:'新任务',duration:6000,minDuration:1000,maxDuration:4000,desiredCount:1,templateId:'t',channelId:'ai',brandConfirmed:true});assert(create.status===200,'新任务未兼容频道确认');
 console.log('EDIT_OK');`
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
    expect(out).toContain('EDIT_OK')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}, 10000)
