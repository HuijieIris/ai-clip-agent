import {writeFileSync,existsSync} from 'node:fs'
import {createCanvas} from '@napi-rs/canvas'
/** 非重叠字幕合成一条稀疏图片轨；避免N条全画幅PNG同时解码/合成。 */
export function subtitleTrack(cues:{pngPath:string;startMs:number;endMs:number}[],durationMs:number,W:number,H:number,output:string):string|null{
 const sorted=cues.filter(c=>existsSync(c.pngPath)&&c.endMs>c.startMs).sort((a,b)=>a.startMs-b.startMs)
 if(!sorted.length||sorted.some((c,i)=>i>0&&c.startMs<sorted[i-1].endMs))return null
 const blank=output+'.blank.png',manifest=output+'.subtitles.ffconcat';writeFileSync(blank,createCanvas(W,H).toBuffer('image/png'))
 const entries:{file:string;duration:number}[]=[];let cursor=0
 for(const cue of sorted){const start=Math.max(0,cue.startMs),end=Math.min(durationMs,cue.endMs);if(end<=start)continue;if(start>cursor)entries.push({file:blank,duration:start-cursor});entries.push({file:cue.pngPath,duration:end-start});cursor=end}
 if(cursor<durationMs)entries.push({file:blank,duration:durationMs-cursor})
 const quote=(file:string)=>"'"+file.replaceAll("'","'\\''")+"'"
 writeFileSync(manifest,'ffconcat version 1.0\n'+entries.map(e=>`file ${quote(e.file)}\noption framerate 1000\nduration ${(e.duration/1000).toFixed(6)}`).join('\n')+`\nfile ${quote(blank)}\noption framerate 1000\n`)
 return manifest
}
