/** 按词边界平衡新闻标题，避免标点出现在行首及单字尾行。 */
export function titleLines(text:string,maxWidth:number,measure:(text:string)=>number,maxLines=3):string[]{
 if(text.includes('\n'))return text.split('\n')
 const Segmenter=(Intl as any).Segmenter
 const tokens:string[]=Segmenter?Array.from(new Segmenter('zh',{granularity:'word'}).segment(text),(x:any)=>x.segment):Array.from(text)
 const units=tokens.flatMap(t=>measure(t)>maxWidth?Array.from(t):[t]);const n=units.length
 if(!n)return []
 for(let lines=1;lines<=maxLines;lines++){
  const target=measure(text)/lines,memo=new Map<string,{cost:number;lines:string[]}|null>()
  const solve=(start:number,left:number):{cost:number;lines:string[]}|null=>{
   if(start===n)return left===0?{cost:0,lines:[]}:null
   if(left<=0)return null;const key=start+':'+left;if(memo.has(key))return memo.get(key)!
   let best:{cost:number;lines:string[]}|null=null
   for(let end=start+1;end<=n;end++){
    const line=units.slice(start,end).join('').trim(),w=measure(line)
    if(w>maxWidth)break
    const before=units.slice(0,end).join(''),after=units.slice(end).join('')
    if(['芯片','内存','逻辑','机器人','人工智能','太阳能','马斯克','美国','中国','产能','瓶颈'].some(word=>Array.from(word).slice(1).some((_,i)=>before.endsWith(word.slice(0,i+1))&&after.startsWith(word.slice(i+1)))))continue
    if(!line||/^[，。！？：；、,.!?:;）】》”’]/u.test(line)||/[（【《“‘]$/u.test(line))continue
    const rest=solve(end,left-1);if(!rest)continue
    const score=(w-target)**2+(Array.from(line).length===1?maxWidth**2:0)+rest.cost
    if(!best||score<best.cost)best={cost:score,lines:[line,...rest.lines]}
   }
   memo.set(key,best);return best
  }
  const result=solve(0,lines);if(result)return result.lines
 }
 // 超长输入仍完整保留，由字号适配/边界检查决定是否可用。
 const result:string[]=[];let line='';for(const char of text){if(measure(line+char)>maxWidth&&line&&!/^[，。！？：；、,.!?:;]/u.test(char)){result.push(line);line=char}else line+=char}if(line)result.push(line);return result
}
