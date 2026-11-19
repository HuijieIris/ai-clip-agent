import { expect,test } from 'bun:test'
import { aliasModelClient } from '../src/highlights/aliases'
import type {ModelClient} from '../src/highlights/model'

test('模型短编号映射回原始句子，不替换文本和引用，也不接受虚构ID',async()=>{
 const segments=[{id:'seg_long-one',start:0,end:1000,text:'S1 is part of the original quote.'},{id:'seg_long-two',start:1000,end:2000,text:'第二句'}]
 const client:ModelClient={async ask(_stage,_task,input:any,validate){
  expect(input.segments[0].id).toBe('S1');expect(input.segments[0].text).toBe(segments[0].text)
  expect(input.candidates[0].id).toBe('C1');expect(input.sources[0].id).toBe('R1')
  return validate({segmentIds:['S001','s2','S999'],candidateId:'C1',sourceIds:['R1'],quote:'S1 is part of the original quote.'})
 }}
 const result:any=await aliasModelClient(client,segments).ask('test','json',{segments,candidates:[{id:'cand_long'}],sources:[{id:'src_long'}]},v=>v)
 expect(result.segmentIds).toEqual(['seg_long-one','seg_long-two','S999']);expect(result.candidateId).toBe('cand_long');expect(result.sourceIds).toEqual(['src_long']);expect(result.quote).toBe(segments[0].text)
})
