import type { TranscriptSegment } from '../types'
import type { ModelClient } from './model'

// 模型只处理简短稳定引用；原始 ID、文本、引文与实际时间不改变。
export function aliasModelClient(client: ModelClient, segments: TranscriptSegment[]): ModelClient {
  const encode = new Map<string,string>(segments.map((s,i)=>[s.id,`S${i+1}`]))
  const decode = new Map<string,string>([...encode].map(([id,alias])=>[alias,id]))
  let candidates=0,sources=0
  const referenceKeys=new Set(['id','segmentId','startSegmentId','endSegmentId','coreSegmentIds','segmentIds','ownedIds','requiredSegmentIds','candidateId','requiredCandidateIds','duplicateOf','sourceIds'])
  function collect(value:unknown):void {
    if(Array.isArray(value)){value.forEach(collect);return}
    if(!value||typeof value!=='object')return
    const v=value as Record<string,unknown>
    if(typeof v.id==='string'&&!encode.has(v.id)){
      const alias=v.id.startsWith('cand_')?`C${++candidates}`:v.id.startsWith('src_')?`R${++sources}`:null
      if(alias){encode.set(v.id,alias);decode.set(alias,v.id)}
    }
    Object.values(v).forEach(collect)
  }
  function transform(value:unknown, direction:'encode'|'decode',key=''):unknown {
    if(typeof value==='string'&&referenceKeys.has(key)){
      const table=direction==='encode'?encode:decode
      const normalized=direction==='decode'&&/^[SCR]0*\d+$/i.test(value)?value.toUpperCase().replace(/^([SCR])0+(\d)/,'$1$2'):value
      return table.get(normalized)||value
    }
    if(Array.isArray(value))return value.map(v=>transform(v,direction,key))
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,transform(v,direction,k)]))
    return value
  }
  return {async ask(stage,task,input,validate,signal){
    collect(input)
    return client.ask(stage,task,transform(input,'encode'),value=>validate(transform(value,'decode')),signal)
  }}
}
