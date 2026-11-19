import { test, expect } from 'bun:test'
import { subtitleDisplayText, outputSubtitles } from '../../../packages/shared/packaging'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
test('展示行尾去标点，保留句内标点与小数，不改原文', () => {
  expect(subtitleDisplayText('你好，世界。\n增长3.14%，继续！')).toBe('你好，世界\n增长3.14%，继续')
  expect(subtitleDisplayText('“保留否定！”')).toBe('“保留否定”')
  const clip: any = {
    subtitles: [{ text: 'First part, second part.' }],
    editPlan: { spans: [{ id: 'a', sourceIn: 0, sourceOut: 4000 }] },
    packaging: {
      sourceCues: [
        {
          id: 's',
          start: 0,
          end: 4000,
          text: '中文第一句，中文第二句。',
          original: 'First part, second part.',
        },
      ],
    },
  }
  expect(outputSubtitles(clip).map((c) => c.text)).toEqual(['中文第一句', '中文第二句'])
  expect(outputSubtitles({ ...clip, subtitleMode: 'bilingual' }).map((c) => c.english)).toEqual([
    'First part',
    'second part',
  ])
})
test('LLM编辑：受控协议、样式/双语编辑、事务回滚、越界拒绝、模型期间版本冲突', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'natural-edit-')),
    root = join(import.meta.dir, '../src')
  const script = `
 const {projects}=await import(${JSON.stringify(root + '/store.ts')});const {editClip,viewClip}=await import(${JSON.stringify(root + '/editing/service.ts')});const {naturalEdit}=await import(${JSON.stringify(root + '/editing/natural-language.ts')});const {defaultTextStyle}=await import(${JSON.stringify(join(import.meta.dir, '../../../packages/shared/packaging.ts'))});
 const assert=(v,m)=>{if(!v)throw Error(m)};
 const pack={version:1,sourceCues:[{id:'s',start:0,end:4000,original:'Original sentence.',text:'原有中文',status:'reviewed',issues:[],highlights:[],locked:false}],candidates:[],coverTitle:'原标题',bodyTitle:'原正文',coverLocked:false,bodyLocked:false,coverStyle:defaultTextStyle(),bodyStyle:defaultTextStyle(),subtitleStyle:defaultTextStyle(32),bodyMode:'all',bodyIntroMs:1000,channelId:'ai'};
 projects.put({id:'p',fileName:'original.mp4',duration:10000,transcript:[],clips:[{id:'c',start:0,end:4000,title:'原标题',subtitles:[{id:'s',start:0,end:4000,text:'Original sentence.'}],packaging:pack,replacements:[],operations:[],status:'draft'}]});
 const fake=ops=>({ask:async(stage,task,input,validate)=>{assert(stage==='natural_edit','没有LLM规划');return validate({summary:'已按要求调整',operations:ops})}});
 let r=await naturalEdit('p','c','字幕缩小并只显示中文',0,fake([{type:'subtitle_style',fontSize:28},{type:'subtitle_mode',mode:'zh'}]));assert(r.clip.packaging.subtitleStyle.fontSize===28&&r.clip.subtitleMode==='zh','多步未执行');
 r=await naturalEdit('p','c','第一句中文改成新文字',r.clip.editPlan.revision,fake([{type:'edit_subtitle',cueId:r.clip.subtitles[0].id,language:'zh',text:'新文字'}]));assert(r.clip.packaging.sourceCues[0].text==='新文字'&&r.clip.packaging.sourceCues[0].locked,'修改未锁定');
 const rev=r.clip.editPlan.revision;let refused=false;try{await naturalEdit('p','c','多步测试',rev,fake([{type:'subtitle_mode',mode:'en'},{type:'trim',start:-1000,end:3000}]))}catch{refused=true}assert(refused,'越界未拒绝');assert(projects.get('p').clips[0].subtitleMode==='zh'&&projects.get('p').clips[0].editPlan.revision===rev,'事务未回滚');
 let conflict=false;const changing={ask:async(stage,task,input,validate)=>{editClip('p','c',{type:'metadata',title:'其他页面已修改'});return validate({summary:'修改',operations:[{type:'subtitle_mode',mode:'en'}]})}};try{await naturalEdit('p','c','改为英文',rev,changing)}catch(e){conflict=e.status===409}assert(conflict,'未拦截模型期间的冲突');
 let rejected=false;try{await naturalEdit('p','c','执行shell',undefined,fake([{type:'shell',command:'rm'}]))}catch{rejected=true}assert(rejected,'越权操作未拒绝');
 let clarified=false;try{await naturalEdit('p','c','换音乐',undefined,fake([]))}catch(e){clarified=e.status===422}assert(clarified,'不支持请求未解释');
 console.log('NATURAL_OK');`
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
    expect(out).toContain('NATURAL_OK')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
