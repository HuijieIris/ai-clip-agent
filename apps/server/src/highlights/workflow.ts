import { aliasModelClient } from './aliases'
import { createHash } from 'node:crypto'
import type { Highlight, TranscriptSegment } from '../types'
import type { HighlightRun, RecommendationOptions, ContentSignal, AudioReview, HighlightDetails, Translation } from '../../../../packages/shared/highlights'
import { uid } from '../store'
import { createModelClient, modelConfig, ModelOutputError } from './model'
import type { ModelClient } from './model'
import { createSearchSession } from './search'
import type { SearchTool } from './search'
import { reviewAudio } from './audio'
import type { AudioTool } from './audio'
import { translateTranscript, TRANSLATION_BATCH_SIZE } from './translation'
import { PROMPT_VERSION, RULES_VERSION, RECALL, REVIEW, MATCH, SIGNALS } from './prompts'
import { object, list, text, choice, ids, bounds, validateSegments, signals, quote, dimensions, score, validRange } from './validation'

interface Candidate { id:string; startSegmentId:string; endSegmentId:string; coreSegmentIds:string[]; title:string; reason:string; signals:ContentSignal[] }
export interface WorkflowDependencies { model?:ModelClient; search?:SearchTool; audio?:AudioTool; onUpdate?:(run:HighlightRun)=>void }
export function windows(segments:TranscriptSegment[], maxDuration:number) {
  const output:{owned:TranscriptSegment[]; context:TranscriptSegment[]}[] = []
  let from=0
  while (from<segments.length) {
    let to=from, chars=0
    while (to<segments.length && to-from<100 && chars+segments[to].text.length<9000 && (to===from || segments[to].end-segments[from].start<=240000)) {chars+=segments[to].text.length;to++}
    if(to===from) throw new Error('单句超出候选窗口容量')
    // 最大候选时长范围的左右上下文，避免30秒上下文不足以补齐较长候选。
    let a=from,b=to
    while(a>0 && segments[from].start-segments[a-1].start<=maxDuration) a--
    while(b<segments.length && segments[b].end-segments[to-1].end<=maxDuration) b++
    const context=segments.slice(a,b)
    if(context.reduce((n,s)=>n+s.text.length,0)>22000 || context.length>300) throw new Error('候选上下文超出预算，请缩短单条最长时长')
    output.push({owned:segments.slice(from,to),context});from=to
  }
  return output
}
export function transcriptText(segments:TranscriptSegment[]) {return segments.map(s=>s.text).join(' ')}
export async function recommendHighlights(segments:TranscriptSegment[], opts:RecommendationOptions, deps:WorkflowDependencies={}) {
  const userSignal=opts.signal
  const timeout=AbortSignal.timeout(Math.max(30000,Math.min(3600000,Number(process.env.HIGHLIGHT_WORKFLOW_TIMEOUT_MS)||600000)))
  opts={...opts,signal:userSignal?AbortSignal.any([userSignal,timeout]):timeout}
  const duration=opts.durationMs ?? segments.at(-1)?.end ?? 0
  validateSegments(segments,duration)
  if(!Number.isFinite(opts.minDuration)||!Number.isFinite(opts.maxDuration)||opts.minDuration<=0||opts.maxDuration<opts.minDuration||!Number.isInteger(opts.count)||opts.count<1||opts.count>30) throw new Error('高光时长或数量参数无效')
  const run:HighlightRun={id:uid('analysis_'),transcriptVersion:createHash('sha256').update(JSON.stringify(segments)).digest('hex'),promptVersion:PROMPT_VERSION,translationVersion:'translation-1.2',rulesVersion:RULES_VERSION,provider:'openai-compatible',model:modelConfig().model,status:'processing',createdAt:Date.now(),requestedCount:opts.count,actualCount:0,warnings:[],rejectionReasons:[],searches:[],translations:[],calls:[]}
  const model=deps.model ?? aliasModelClient(createModelClient(run.calls, Math.min(400,Math.max(100,Math.ceil(segments.length/TRANSLATION_BATCH_SIZE)*4+30))),segments), search=createSearchSession(deps.search,opts.searchMode??'auto',opts.signal)
  const update=(message:string)=>{opts.signal?.throwIfAborted();run.searches=search.results;opts.onProgress?.(message);deps.onUpdate?.(run)}
  try {
    update('正在翻译原文并对照复核')
    const previous=opts.resumeRun
    const reusable=previous?.transcriptVersion===run.transcriptVersion && (previous.translationVersion===run.translationVersion || (!previous.translationVersion && previous.promptVersion==='highlight-bilingual-1.2')) && previous.model===run.model ? previous.translations : []
    const translations=await translateTranscript(segments,model,search,opts.signal,items=>{run.translations=[...items];update(`已完成 ${items.length}/${segments.length} 句双语处理`)},reusable)
    const translated=new Map(translations.map(t=>[t.segmentId,t]))
    const withTranslation=(ss:TranscriptSegment[])=>ss.map(s=>({...s,textZh:translated.get(s.id)?.textZh,translationStatus:translated.get(s.id)?.status}))
    const settingsVersion=createHash('sha256').update(JSON.stringify([opts.minDuration,opts.maxDuration,opts.count,opts.profile||'',opts.searchMode||'auto',opts.recordedAt||''])).digest('hex')
    const previousRecall=previous?.status!=='completed' && previous?.transcriptVersion===run.transcriptVersion && previous.promptVersion===PROMPT_VERSION && previous.model===run.model && previous.recall?.settingsVersion===settingsVersion ? previous.recall : undefined
    if(previousRecall)run.recall=structuredClone(previousRecall)
    let candidates:Candidate[]=previousRecall?structuredClone(previousRecall.candidates):[]
    const topics:{summary:string;segmentIds:string[]}[]=previousRecall?structuredClone(previousRecall.topics):[]
    const allWindows=windows(segments,opts.maxDuration)
    for (const [index,window] of allWindows.entries()) {
      if(index<(previousRecall?.completedWindows||0)) continue
      update(`内容理解与候选召回 ${index+1}/${allWindows.length}`)
      const result=await model.ask('recall',RECALL,{segments:withTranslation(window.context),ownedIds:window.owned.map(s=>s.id),minDuration:opts.minDuration,maxDuration:opts.maxDuration,quota:Math.min(3,Math.max(1,Math.floor(40/allWindows.length))),profile:opts.profile||null,recordedAt:opts.recordedAt||null,signals:SIGNALS},value=>{
        const v=object(value,['topics','candidates','queries'])
        const topics=list(v.topics,20).map(item=>{const t=object(item,['summary','segmentIds']);return {summary:text(t.summary,500),segmentIds:ids(t.segmentIds,window.context)}})
        const cs=list(v.candidates,6).flatMap(item=>{
          const c=object(item,['startSegmentId','endSegmentId','coreSegmentIds','title','reason','signals'])
          const proposed=bounds(c.startSegmentId,c.endSegmentId,window.context)
          const core=ids(c.coreSegmentIds,window.context)
          if(!core.some(id=>window.owned.some(s=>s.id===id))) return [] // 仅来自相邻上下文的候选交给其所属窗口，不应使整批失败。
          // 核心句是真实窗口内原文，但模型起止可能少含一句。先补齐核心，再由复评和时长门槛决定可用性。
          const indexes=core.map(id=>window.context.findIndex(s=>s.id===id))
          const a=Math.min(proposed.a,...indexes),b=Math.max(proposed.b,...indexes)
          const selected=window.context.slice(a,b+1)
          const validSignals=signals(c.signals,window.context).filter(s=>s.segmentIds.every(id=>selected.some(x=>x.id===id)))
          return [{id:uid('cand_'),startSegmentId:window.context[a].id,endSegmentId:window.context[b].id,coreSegmentIds:core,title:text(c.title,150),reason:text(c.reason,800),signals:validSignals}]
        })
        const queries=list(v.queries,2).map(item=>{const q=object(item,['purpose','query']);return {purpose:choice(q.purpose,['news','translation','background','fact_check'] as const),query:text(q.query,300)}})
        return {topics,candidates:cs,queries}
      },opts.signal)
      topics.push(...result.topics)
      for (const c of result.candidates) {
        const b=bounds(c.startSegmentId,c.endSegmentId,segments)
        // 时长不足仍保留交给全局复评修复；不允许跨已知ASR缺失区间。
        if((opts.missingRanges??[]).some(r=>r.start<b.end&&r.end>b.start)) {run.rejectionReasons.push(`${c.id}：跨越ASR缺失区间`);continue}
        if(!candidates.some(x=>x.startSegmentId===c.startSegmentId&&x.endSegmentId===c.endSegmentId))candidates.push(c)
      }
      for (const q of result.queries) {
        if(opts.searchMode==='off') break
        if(q.purpose==='news' && !result.candidates.some(c=>c.signals.some(s=>s.ruleId==='timely_event')) && opts.searchMode!=='required')continue
        update(`联网检索：${q.purpose==='news'?'新闻关联':q.purpose==='translation'?'术语核验':'背景与事实'}`)
        await search.search(q)
      }
      run.recall={settingsVersion,completedWindows:index+1,candidates:structuredClone(candidates),topics:structuredClone(topics)}
      update(`已完成候选召回 ${index+1}/${allWindows.length}`)
    }
    if(candidates.length>40) {
      candidates.sort((a,b)=>bounds(a.startSegmentId,a.endSegmentId,segments).start-bounds(b.startSegmentId,b.endSegmentId,segments).start)
      candidates=Array.from({length:40},(_,i)=>candidates[Math.floor(i*candidates.length/40)])
      run.warnings.push('候选超过40条，按时间分散取样进入全局复评')
    }
    if(opts.searchMode==='required'&&!search.results.length) await search.search({purpose:'background',query:topics[0]?.summary||'视频内容背景'})
    run.searches=search.results
    if(search.results.some(r=>r.status==='unavailable'))run.warnings.push('未配置联网搜索，相关术语/新闻未完成外部检索')
    if(search.results.some(r=>r.status==='error'))run.warnings.push('部分联网搜索失败或达到预算；不视为没有相关报道')
    const audioMap=new Map<string,AudioReview>()
    for(const [index,c] of candidates.entries()) {
      update(`候选原音频复听 ${Math.min(index+1,5)}/${Math.min(candidates.length,5)}`)
      if(index>=5){audioMap.set(c.id,{status:'skipped',observations:[],transcriptCheck:'unknown',issues:['超过每次5条音频复听预算，需人工回听']});continue}
      const b=bounds(c.startSegmentId,c.endSegmentId,segments)
      const audio=opts.audioPath?await (deps.audio??reviewAudio)({audioPath:opts.audioPath,start:b.start,end:b.end,original:transcriptText(b.selected),chinese:b.selected.map(s=>translated.get(s.id)?.textZh||s.text).join(' ')},opts.signal):{status:'unavailable' as const,observations:[],transcriptCheck:'unknown' as const,issues:['未提供原音频，未执行声音分析']}
      audioMap.set(c.id,audio)
    }
    if([...audioMap.values()].some(a=>a.status!=='reviewed'))run.warnings.push('部分候选未完成原音频模型复听；文本语气仅为文字推断')
    const trends=new Map<string,HighlightDetails['trend']>()
    const newsSources=search.results.filter(r=>r.purpose==='news'&&r.status==='ok').flatMap(r=>r.sources)
    if(newsSources.length && candidates.length) {
      const matches=await model.ask('news_match',MATCH,{analysisDate:new Date().toISOString(),recordedAt:opts.recordedAt||null,candidates,segments:withTranslation(segments.filter(s=>candidates.some(c=>bounds(c.startSegmentId,c.endSegmentId,segments).selected.some(x=>x.id===s.id)))),sources:newsSources},value=>{
        const v=object(value,['matches']);const seen=new Set<string>()
        return list(v.matches,candidates.length).map(item=>{const m=object(item,['candidateId','status','relation','sourceIds','reason']);const id=text(m.candidateId,100)
          if(!candidates.some(c=>c.id===id)||seen.has(id))throw new Error('新闻关联候选ID错误');seen.add(id)
          const sourceIds=list(m.sourceIds,10).map(i=>text(i,100));if(sourceIds.some(id=>!newsSources.some(s=>s.id===id)))throw new Error('引用未知搜索来源')
          const status=choice(m.status,['matched','unmatched','insufficient_evidence'] as const), relation=choice(m.relation,['same_event','topic_related','none'] as const)
          if(status==='matched'&&(!sourceIds.length||relation==='none'))throw new Error('新闻匹配缺少关联或来源')
          return {id,status,relation,sourceIds,reason:text(m.reason,500),verificationStatus:'partial' as const}
        })
      },opts.signal)
      for(const m of matches)trends.set(m.id,m)
    }
    const accepted:Highlight[]=[]
    if(candidates.length){
      update('正在全局复评与校验切点')
      // 仅提供候选附近上下文，避免整部长视频超过模型上下文预算。
      const reviewSegments=segments.filter(s=>candidates.some(c=>{const b=bounds(c.startSegmentId,c.endSegmentId,segments);return s.end>=b.start-opts.maxDuration&&s.start<=b.end+opts.maxDuration}))
      if(reviewSegments.reduce((n,s)=>n+s.text.length+(translated.get(s.id)?.textZh.length||0),0)>100000)throw new Error('全局复评上下文超过预算，请减少候选数量或缩短素材')
      const parseReview=(value:unknown, targets:Candidate[]=candidates, available:TranscriptSegment[]=reviewSegments)=>{
        const v=object(value,['reviews']),seen=new Set<string>()
        const reviews=list(v.reviews,40).filter(item=>{const r=object(item);return targets.some(c=>c.id===r.candidateId)}).map(item=>{
          const r=object(item,['candidateId','decision','startSegmentId','endSegmentId','title','reason','tags','dimensions','evidence','duplicateOf','reviewFlags','rejectionReason'])
          const candidateId=text(r.candidateId,100)
          if(!targets.some(c=>c.id===candidateId)||seen.has(candidateId))throw new Error('复评候选编号错误或重复');seen.add(candidateId)
          const b=bounds(r.startSegmentId,r.endSegmentId,available)
          if(r.duplicateOf!==null&&(!candidates.some(c=>c.id===r.duplicateOf)||r.duplicateOf===candidateId))throw new Error('重复候选引用错误')
          const evidence=list(r.evidence,100).map(i=>quote(i,b.selected)).slice(0,10)
          const decision=choice(r.decision,['accept','reject','needs_boundary_repair'] as const)
          if(decision==='accept'&&!evidence.length)throw new Error('接受候选必须引用原文')
          return {candidateId,decision,startSegmentId:text(r.startSegmentId,100),endSegmentId:text(r.endSegmentId,100),title:text(r.title,150),reason:text(r.reason,800),tags:list(r.tags??[],20).slice(0,3).map(t=>text(t,40)),dimensions:dimensions(r.dimensions,b.selected,opts.profile),evidence,duplicateOf:r.duplicateOf as string|null,reviewFlags:list(r.reviewFlags??[],20).map(t=>text(t,100)),rejectionReason:r.rejectionReason===null?null:text(r.rejectionReason,500)}
        })
        if(seen.size!==targets.length)throw new Error('全局复评遗漏候选')
        return reviews
      }
      // 每次只详细复评一条，附带全局概览去重；两路并发避免长视频输出过长或单请求超时。
      const reviews:ReturnType<typeof parseReview>=previousRecall && previous?.reviewed ? structuredClone(previous.reviewed) : []
      run.reviewed=structuredClone(reviews)
      const queue=candidates.filter(c=>!reviews.some(r=>r.candidateId===c.id))
      const abort=new AbortController()
      const reviewSignal=AbortSignal.any([opts.signal!,abort.signal])
      let failure:unknown
      const workers=Array.from({length:Math.min(2,queue.length)},async()=>{
        while(queue.length&&!failure){
          const candidate=queue.shift()!
          try{
            update(`全局复评 ${reviews.length+1}/${candidates.length}`)
            const batch=[candidate]
            const nearby=reviewSegments.filter(s=>{const b=bounds(candidate.startSegmentId,candidate.endSegmentId,segments);return s.end>=b.start-30000&&s.start<=b.end+30000})
            const input={candidates:batch,globalCandidates:candidates.map(c=>({id:c.id,title:c.title,reason:c.reason})),requiredCandidateIds:[candidate.id],segments:withTranslation(nearby),profile:opts.profile||null,minDuration:opts.minDuration,maxDuration:opts.maxDuration,audio:[[candidate.id,audioMap.get(candidate.id)]],topics:topics.slice(0,80)}
            let checked=await model.ask('global_review',REVIEW+' 本次只返回candidates中的这一条，理由尽量简短，维度理由每项不超过30字。',input,value=>parseReview(value,batch,nearby),reviewSignal)
            if(checked.some(r=>r.decision==='needs_boundary_repair'||(r.decision==='accept'&&!validRange(bounds(r.startSegmentId,r.endSegmentId,segments).start,bounds(r.startSegmentId,r.endSegmentId,segments).end,opts.minDuration,opts.maxDuration,opts.missingRanges)))){
              checked=await model.ask('boundary_repair',REVIEW+' 本次为最后一次边界修复，仍不符合时长/语义条件必须reject。',{...input,priorReviews:checked,missingRanges:opts.missingRanges||[]},value=>parseReview(value,batch,nearby),reviewSignal)
            }
            reviewSignal.throwIfAborted()
            reviews.push(...checked)
            run.reviewed=structuredClone(reviews)
            update(`已完成全局复评 ${reviews.length}/${candidates.length}`)
          }catch(error){
            if(error instanceof ModelOutputError){run.rejectionReasons.push(`${candidate.id}：复评输出未通过校验，已跳过：${error.message}`);continue}
            if(!failure){failure=error;abort.abort()}
          }
        }
      })
      await Promise.all(workers)
      if(failure)throw failure
      if(!reviews.length)throw new Error('所有候选的模型复评输出均未通过校验，请重试高光分析；原文、译文和候选已保留')
      for(const r of reviews){
        const b=bounds(r.startSegmentId,r.endSegmentId,segments),finalScore=score(r.dimensions)
        if(r.decision!=='accept'||r.duplicateOf||!validRange(b.start,b.end,opts.minDuration,opts.maxDuration,opts.missingRanges)||finalScore<70||r.dimensions.semantic_completeness.score<4||r.dimensions.evidence_fidelity.score<3){run.rejectionReasons.push(`${r.candidateId}：${r.rejectionReason||'未通过完整性、时长、去重或评分门槛'}`);continue}
        const c=candidates.find(c=>c.id===r.candidateId)!
        const audio=audioMap.get(c.id)!
        // 修复后原音频检查只覆盖旧边界，不能标为新边界已复听。
        const originalBounds=bounds(c.startSegmentId,c.endSegmentId,segments)
        const finalAudio=b.start!==originalBounds.start||b.end!==originalBounds.end?{status:'skipped' as const,observations:[],transcriptCheck:'unknown' as const,issues:['复评调整了切点，需要按新范围重新回听']}:audio
        const reviewFlags=[...r.reviewFlags,...(!opts.profile?['profile_defaulted']:[]),...(b.selected.some(s=>translated.get(s.id)?.status==='needs_review')?['translation_needs_review']:[]),...(finalAudio.transcriptCheck==='needs_review'?['audio_check_needed']:[])]
        const news=search.results.filter(s=>s.purpose==='news')
        const trend=trends.get(c.id)||{status:opts.searchMode==='off'||!news.length?'skipped':news.some(s=>s.status==='error')?'error':news.some(s=>s.status==='unavailable')?'unavailable':'insufficient_evidence',relation:'none',sourceIds:[],reason:'未取得足够新闻证据，不代表没有关联',verificationStatus:'unverified'} as HighlightDetails['trend']
        accepted.push({id:uid('hl_'),title:r.title,reason:r.reason,start:b.start,end:b.end,score:finalScore,transcript:transcriptText(b.selected),tags:r.tags,status:'draft',details:{analysisRunId:run.id,transcriptVersion:run.transcriptVersion,source:'llm',startSegmentId:r.startSegmentId,endSegmentId:r.endSegmentId,transcriptZh:b.selected.map(s=>translated.get(s.id)?.textZh||s.text).join(' '),dimensions:r.dimensions,signals:c.signals.filter(s=>s.segmentIds.every(id=>b.selected.some(x=>x.id===id))),evidence:r.evidence,reviewFlags:[...new Set(reviewFlags)],trend,audio:finalAudio}})
      }
    }
    const highlights:Highlight[]=[]
    for(const h of accepted.sort((a,b)=>b.score-a.score)){
      if(highlights.some(p=>Math.max(0,Math.min(p.end,h.end)-Math.max(p.start,h.start))/Math.min(p.end-p.start,h.end-h.start)>0.6)){run.rejectionReasons.push(`${h.id}：强重叠候选已去重`);continue}
      if(highlights.length<opts.count)highlights.push(h)
    }
    if(highlights.length<opts.count)run.warnings.push(`目标${opts.count}条，实际${highlights.length}条；未为凑数降低质量或时长要求`)
    run.actualCount=highlights.length;run.status='completed';run.finishedAt=Date.now();update('高光分析完成')
    return {highlights,source:'cloud' as const,run,translations}
  }catch(error){run.status=userSignal?.aborted?'cancelled':'failed';run.finishedAt=Date.now();run.warnings.push(error instanceof Error?error.message:'高光分析失败');run.searches=search.results;deps.onUpdate?.(run);throw error}
}
