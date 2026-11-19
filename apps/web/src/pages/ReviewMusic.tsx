import {useEffect,useId,useRef,useState, type ReactNode} from 'react'
import { ms } from '../lib/time'
import type {BgmSettings,MusicTrack,MusicRecommendation} from '../../../../packages/shared/music'
import './ReviewMusic.css'
async function json(url:string,options?:RequestInit){const r=await fetch(url,options);const v=await r.json();if(!r.ok)throw Error(v.error||'音乐请求失败');return v}
export function ReviewMusic({pid,cid,duration,value,onChange,visible,onLibrary,clipCount,onApplyAll}: {
 pid:string; cid:string; duration:number; value?:BgmSettings; onChange:(v:BgmSettings)=>void
 visible:boolean; onLibrary:(tracks:MusicTrack[])=>void; clipCount:number; onApplyAll:()=>void
}){
 const [library,setLibrary]=useState<MusicTrack[]>([]),[recommend,setRecommend]=useState<MusicRecommendation|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[tab,setTab]=useState<'ai'|'mine'>('ai')
 const [audition, setAudition] = useState<string>()
 const audio = useRef<HTMLAudioElement>(null)
 const request=useRef(0)
 const requested=useRef(false)
 const choose=(track:MusicTrack)=>onChange({
  enabled:true, trackId:track.id, volume:value?.volume??.2, sourceIn:0, start:0, end:duration,
  fadeIn:value?.fadeIn??1000, fadeOut:value?.fadeOut??1000, ducking:value?.ducking??true,
 })
 const load=async()=>{
  requested.current=true
  const generation=++request.current
  setBusy(true)
  setError('')
  try {
   const result=await json(`/api/music/recommend/${pid}/${cid}`,{method:'POST'})
   if(generation===request.current)setRecommend(result)
  } catch(e) {
   if(generation===request.current)setError((e as Error).message)
  } finally {
   if(generation===request.current)setBusy(false)
  }
 }
 useEffect(()=>{
  let active=true
  void json('/api/music/library').then(tracks=>{
   if(active){setLibrary(tracks);onLibrary(tracks)}
  }).catch(e=>{if(active)setError(e.message)})
  return()=>{active=false;request.current++;requested.current=false}
 },[pid,cid])
 useEffect(()=>{
  if(visible && !requested.current)void load()
  if(!visible)audio.current?.pause()
 },[visible])
 const patch=(patch:Partial<BgmSettings>)=>{if(value)onChange({...value,...patch})}
 const selected=library.find(track=>track.id===value?.trackId)
 const recommendedTracks = recommend?.tracks ?? []
 const tracks = tab==='ai' ? recommendedTracks : library
 const toggleAudition = (track:MusicTrack) => {
  const player = audio.current
  if(!player)return
  if(audition===track.id){player.pause();return}
  player.src=track.url
  setAudition(track.id)
  void player.play().catch(e=>{setAudition(undefined);setError(e.message)})
 }
 return <section hidden={!visible} className="review-music">
  <div className="row music-heading"><h3>♫ 背景音乐（BGM）</h3><label><input type="checkbox" role="switch" disabled={!value && !library.length} aria-label="启用背景音乐" checked={value?.enabled??false} onChange={e=>value?patch({enabled:e.target.checked}):choose(recommendedTracks[0]??library[0])}/></label></div>
  <div className="music-tabs"><button className={`chip ${tab==='ai'?'on':''}`} onClick={()=>setTab('ai')}>AI 推荐</button><button className={`chip ${tab==='mine'?'on':''}`} onClick={()=>setTab('mine')}>我的音乐</button></div>
  {tab==='ai'&&<div className="row music-heading"><b>智能推荐（{recommendedTracks.length}）</b><button className="btn btn-sm btn-ghost" disabled={busy} onClick={()=>void load()}>{busy?'推荐中…':'重新推荐'}</button></div>}
  {error&&<p className="tiny" role="alert">{error}</p>}
  <audio ref={audio} preload="none" onPause={()=>setAudition(undefined)} onEnded={()=>setAudition(undefined)}/>
  <div className="music-list">
   {tracks.map((track,index)=><article key={track.id} className={`music-card ${value?.trackId===track.id?'selected':''}`}>
    <span className="music-art" data-color={index%3} aria-hidden="true">♫</span>
    <button className="music-audition" aria-label={`${audition===track.id?'暂停':'试听'} ${track.name}`} onClick={()=>toggleAudition(track)}>{audition===track.id?'Ⅱ':'▶'}</button>
    <button className="music-track-title" aria-pressed={value?.trackId===track.id && value.enabled} onClick={()=>choose(track)}>
     <b>{track.name}</b><small>{ms(track.duration)} · {track.mood} · {track.license}</small>
    </button>
    {tab==='ai'&&index===0&&<span className="music-recommended">推荐</span>}
   </article>)}
  </div>
  {tab==='ai'&&recommend&&<p className="music-reason tiny"><b>推荐理由</b> {recommendedTracks.find(track=>track.id===value?.trackId)?.reason??recommend.summary}</p>}
  {tab==='mine'&&<label className="btn btn-sm btn-secondary">上传音乐<input type="file" accept="audio/*" hidden onChange={async e=>{
   const file=e.target.files?.[0]
   if(!file)return
   const form=new FormData()
   form.append('file',file)
   try {
    const track=await json('/api/music/upload',{method:'POST',body:form})
    const updated=[...library,track]
    setLibrary(updated)
    onLibrary(updated)
    choose(track)
   } catch(e){setError((e as Error).message)}
  }}/></label>}
  <h4>音频设置</h4>
  {value ? <>
   <label className="music-volume"><span>音乐音量</span><div className="row"><input type="range" min="0" max="1" step=".01" value={value.volume} onChange={e=>patch({volume:+e.target.value})}/><output>{Math.round(value.volume*100)}%</output></div></label>
   <label className="music-ducking"><input type="checkbox" checked={value.ducking} onChange={e=>patch({ducking:e.target.checked})}/> 人声优先（自动降低 BGM 音量）</label>
   <div className="music-inputs">{(['fadeIn','fadeOut'] as const).map((key,i)=><label key={key}>{i===0?'淡入':'淡出'}
    <select aria-label={i===0?'淡入':'淡出'} value={value[key]} onChange={e=>patch({[key]:+e.target.value})}>
     {[...new Set([0,500,1000,1500,2000,3000,5000,10000,value[key]])].sort((a,b)=>a-b).map(ms=><option key={ms} value={ms}>{ms/1000} s</option>)}
    </select>
   </label>)}</div>
   <details className="music-advanced"><summary>播放区间</summary><div className="music-inputs">{(['sourceIn','start','end'] as const).map((key,i)=><label key={key}>{['音乐起点','应用开始','应用结束'][i]}（秒）
    <input type="number" min="0" max={(key==='sourceIn'?(selected?.duration??duration):duration)/1000} step=".1" value={+(value[key]/1000).toFixed(2)} onChange={e=>{
     const n=e.target.valueAsNumber*1000
     if(!Number.isFinite(n)||n<0||(key==='end'&&(n<=value.start||n>duration))||(key==='start'&&n>=value.end))return
     patch({[key]:n})
    }}/>
   </label>)}</div></details>
  </> : <p className="tiny muted">选择一首音乐后可调整音量、淡入和淡出。</p>}
  <button className="btn btn-secondary btn-block music-apply" disabled={!value} onClick={onApplyAll}>▱ 将 BGM 应用全部 {clipCount} 条片段</button>
 </section>
}
const graphs=new WeakMap<HTMLMediaElement,{ctx:AudioContext;analyser:AnalyserNode}>()
/** Browser preview: the real voice signal drives music gain. Rendered previews already contain their own mix. */
export function MusicPreview({mediaId,bgm,track,rendered,outputTime,mediaKey}:{mediaId:string;bgm?:BgmSettings;track?:MusicTrack;rendered:boolean;outputTime:(source:number)=>number|null;mediaKey:string}){
 const settings=useRef(bgm);settings.current=bgm
 const mapTime=useRef(outputTime);mapTime.current=outputTime
 useEffect(()=>{
  const video=document.getElementById(mediaId) as HTMLVideoElement|null
  if(!video||!bgm?.enabled||!track||rendered)return
  const music=new Audio(track.url);music.loop=true;music.preload='auto'
  let graph=graphs.get(video)
  if(!graph){const ctx=new AudioContext(),analyser=ctx.createAnalyser();analyser.fftSize=256;const voice=ctx.createMediaElementSource(video);voice.connect(analyser);analyser.connect(ctx.destination);graph={ctx,analyser};graphs.set(video,graph)}
  const {ctx,analyser}=graph,musicSource=ctx.createMediaElementSource(music),gain=ctx.createGain();musicSource.connect(gain);gain.connect(ctx.destination)
  const samples=new Uint8Array(analyser.fftSize);let raf=0,disposed=false
  const tick=()=>{if(disposed)return;const bgm=settings.current;if(!bgm)return;const ms=mapTime.current(video.currentTime*1000)??-1,active=!video.paused&&ms>=bgm.start&&ms<bgm.end
   if(active){const desired=(bgm.sourceIn+ms-bgm.start)%track.duration/1000;if(Math.abs(music.currentTime-desired)>.2)music.currentTime=desired;if(music.paused)void music.play().catch(()=>{})}else music.pause()
   analyser.getByteTimeDomainData(samples);const rms=Math.sqrt(samples.reduce((n,v)=>n+((v-128)/128)**2,0)/samples.length)
   const envelope=Math.max(0,Math.min(1,bgm.fadeIn?(ms-bgm.start)/bgm.fadeIn:1,bgm.fadeOut?(bgm.end-ms)/bgm.fadeOut:1))
   gain.gain.setTargetAtTime(active?bgm.volume*envelope*(bgm.ducking&&rms>.025?.2:1):0,ctx.currentTime,.06);raf=requestAnimationFrame(tick)
  }
  const play=()=>{cancelAnimationFrame(raf);void ctx.resume();tick()};video.addEventListener('play',play);if(!video.paused)void ctx.resume();tick()
  return()=>{disposed=true;cancelAnimationFrame(raf);video.removeEventListener('play',play);music.pause();musicSource.disconnect();gain.disconnect();setTimeout(()=>{if(!video.isConnected){void ctx.close();graphs.delete(video)}},0)}
 },[mediaId,bgm?.enabled,bgm?.trackId,track,rendered,mediaKey]);return null
}
export function TrackLabel({label, hidden, onSelect, onToggle}: {
 label:string; hidden:boolean; onSelect:()=>void; onToggle:()=>void
}){
 return <div className="track-label">
  <button onClick={onSelect}>{label}</button>
  <button className="track-visibility" aria-label={`${hidden?'显示':'隐藏'}${label}预览`} aria-pressed={!hidden} onClick={onToggle}>
   <span aria-hidden="true">{hidden?'◌':'◉'}</span>
  </button>
 </div>
}

function Waveform({track,sourceIn,length}:{track?:MusicTrack;sourceIn:number;length:number}){
 const [peaks,setPeaks]=useState<{id:string;values:number[]}>()
 useEffect(()=>{
  if(!track)return
  const controller=new AbortController()
  void (async()=>{
   try {
    const response=await fetch(track.url,{signal:controller.signal})
    if(!response.ok)return
    const buffer=await response.arrayBuffer()
    if(controller.signal.aborted)return
    const context=new OfflineAudioContext(1,1,44100)
    const decoded=await context.decodeAudioData(buffer)
    const data=decoded.getChannelData(0)
    const values=Array.from({length:512},(_,i)=>{
     const start=Math.floor(i*data.length/512),end=Math.floor((i+1)*data.length/512)
     let peak=0
     for(let j=start;j<end;j+=Math.max(1,Math.floor((end-start)/100)))peak=Math.max(peak,Math.abs(data[j]))
     return peak
    })
    if(!controller.signal.aborted)setPeaks({id:track.id,values})
   }catch{/* Playback remains available if waveform analysis fails. */}
  })()
  return()=>controller.abort()
 },[track?.url,track?.id])
 if(!track || !track.duration || !peaks || peaks.id!==track.id)return null
 return <span className="music-waveform" aria-hidden="true">{Array.from({length:100},(_,i)=>{
  const position=((sourceIn+length*i/100)%track.duration)/track.duration
  return <i key={i} style={{height:`${Math.max(7,peaks.values[Math.floor(position*512)]*100)}%`}}/>
 })}</span>
}

export function MusicTimeline({duration,value,onChange,onSeek,time,track,onMusicSelect,onTitleSelect,onSubtitleSelect,hiddenTracks,onToggleTrack,tools,children}:{
 duration:number; value?:BgmSettings; onChange:(v:BgmSettings)=>void; onSeek:(ms:number)=>void; time:number
 track?:MusicTrack; onMusicSelect:()=>void; onTitleSelect:()=>void; onSubtitleSelect:()=>void
 hiddenTracks:string[]; onToggleTrack:(track:string)=>void; tools:ReactNode; children:ReactNode
}){
 const [drawer,setDrawer]=useState<'initial'|'open'|'closed'>('initial')
 const expanded=drawer==='open'
 const drawerId=useId()
 const [zoom,setZoom]=useState(1)
 const [showAdd,setShowAdd]=useState(false)
 const viewport=useRef<HTMLDivElement>(null)
 const position=Math.min(100,Math.max(0,time/Math.max(1,duration)*100))
 const ticks=5*zoom
 useEffect(()=>{
  const el=viewport.current
  if(!expanded||!el||zoom===1)return
  const playhead=80+(el.scrollWidth-80)*position/100
  if(playhead>el.scrollLeft+el.clientWidth-12 || playhead<el.scrollLeft+12)
   el.scrollLeft=playhead-el.clientWidth/2
 },[expanded,position,zoom])
 return <section className="panel music-timeline" aria-label="成片时间线">
  <div id={drawerId} hidden={!expanded}>
   {drawer!=='initial'&&<>
     <div className="track-toolbar">
      <div className="track-edit-tools">{tools}</div>
      <div className="track-zoom">
       <button aria-label="缩小时间线" disabled={zoom===1} onClick={()=>setZoom(zoom-1)}>−</button>
       <input type="range" min={1} max={4} value={zoom} aria-label="时间线缩放" onChange={e=>setZoom(+e.target.value)}/>
       <button aria-label="放大时间线" disabled={zoom===4} onClick={()=>setZoom(zoom+1)}>+</button>
       <button onClick={()=>{setZoom(1);if(viewport.current)viewport.current.scrollLeft=0}}>适配</button>
      </div>
     </div>
     <div ref={viewport} className="track-scroll">
      <div className="track-content" style={{width:`${zoom*100}%`}}>
       <div className="track-ruler">
        <div className="track-ticks" aria-hidden="true">{Array.from({length:ticks+1},(_,i)=><span key={i} style={{left:`${i/ticks*100}%`}}>{ms(duration*i/ticks)}</span>)}</div>
        <div className="track-time" aria-hidden="true" style={{left:`${position}%`}}>{ms(time)}.{Math.floor(time%1000/100)}</div>
        <input type="range" aria-label="时间线播放位置" min={0} max={duration} value={Math.round(Math.min(time,duration))} onChange={e=>onSeek(Number(e.target.value))}/>
       </div>
       <div className="track-stack">
        {children}
        <ReviewRange label="BGM" duration={duration} onSelect={onMusicSelect}
         hidden={hiddenTracks.includes('BGM')} onToggle={()=>onToggleTrack('BGM')}
         range={value} onChange={range=>{if(value)onChange({...value,...range})}} variant="music" inactive={!value?.enabled}>
         ♫ {track?.name??'背景音乐'}{value&&<Waveform track={track} sourceIn={value.sourceIn} length={value.end-value.start}/>}
        </ReviewRange>
        <div className="track-playhead-area" aria-hidden="true"><div className="music-playhead" style={{left:`${position}%`}} /></div>
       </div>
      </div>
     </div>
     <div className="track-footer">
      <button className="btn btn-secondary btn-sm" aria-expanded={showAdd} onClick={()=>setShowAdd(!showAdd)}>＋ 添加轨道 ⌄</button>
      {showAdd&&<div className="track-add-menu">
       <button onClick={()=>{onTitleSelect();setShowAdd(false)}}>T　标题文字</button>
       <button onClick={()=>{onSubtitleSelect();setShowAdd(false)}}>T　口播字幕</button>
       <button onClick={()=>{onMusicSelect();setShowAdd(false)}}>♫　背景音乐</button>
      </div>}
     </div>
   </>}
  </div>
  <button type="button" className="track-drawer-toggle" aria-controls={drawerId} aria-expanded={expanded} onClick={()=>{
   setDrawer(expanded?'closed':'open')
   setShowAdd(false)
  }}>
   <span><b>时间线</b><small className="mono muted">{ms(time)} / {ms(duration)}</small></span>
   <span>{expanded?'收起 ⌄':'展开 ⌃'}</span>
  </button>
 </section>
}

export function ReviewRange({label,duration,range,onChange,onSelect,onToggle,hidden,children,trimOnly=false,variant='text',inactive=false}:{
 label:string;duration:number;range?:{start:number;end:number};onChange:(r:{start:number;end:number})=>void
 onSelect:()=>void;onToggle:()=>void;hidden:boolean;children?:ReactNode;trimOnly?:boolean;variant?:'text'|'music';inactive?:boolean
}){
 const drag=useRef<{x:number;start:number;end:number;mode:string;width:number}|null>(null)
 return <div className={`track-row ${hidden?'track-hidden':''}`}>
  <TrackLabel label={label} hidden={hidden} onSelect={onSelect} onToggle={onToggle}/>
  <div className="timeline-lane">{range&&<div className={`music-range ${trimOnly?'track-video':variant==='music'?'track-music':'track-text'} ${inactive?'track-inactive':''}`}
   style={{left:`${range.start/duration*100}%`,width:`${(range.end-range.start)/duration*100}%`}}
   onPointerDown={e=>{
    const mode=(e.target as HTMLElement).dataset.handle??'move'
    if(trimOnly&&mode==='move')return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current={x:e.clientX,start:range.start,end:range.end,mode,width:e.currentTarget.parentElement!.getBoundingClientRect().width}
   }}
   onPointerMove={e=>{
    const d=drag.current
    if(!d)return
    const delta=(e.clientX-d.x)/d.width*duration
    let {start,end}=d
    const min=Math.min(trimOnly?1000:100,d.end-d.start)
    if(d.mode==='left')start=Math.max(0,Math.min(end-min,start+delta))
    else if(d.mode==='right')end=Math.min(duration,Math.max(start+min,end+delta))
    else {start=Math.max(0,Math.min(duration-(end-start),start+delta));end=start+d.end-d.start}
    onChange({start:Math.round(start),end:Math.round(end)})
   }}
   onLostPointerCapture={()=>{drag.current=null}}>{children}<i className="track-handle left" data-handle="left"/><i className="track-handle right" data-handle="right"/></div>}</div>
 </div>
}

type FilmSpan={id:string;sourceIn:number;sourceOut:number;outputIn:number;outputOut:number}
export function Filmstrip({duration,hidden,onToggle,src,spans,selected,onSettings,onSelect}:{
 duration:number;hidden:boolean;onToggle:()=>void;src:string;spans:FilmSpan[];selected?:string;onSettings:()=>void;onSelect:(id:string,time:number)=>void
}){
 const [frames,setFrames]=useState<Record<string,string[]>>({})
 const signature=spans.map(span=>`${span.id}:${span.sourceIn}:${span.sourceOut}`).join(',')
 useEffect(()=>{
  const media=document.createElement('video')
  const canvas=document.createElement('canvas')
  canvas.width=100
  canvas.height=54
  const context=canvas.getContext('2d')
  if(!context)return
  let cancelled=false
  const samples=spans.flatMap(span=>{
   const count=Math.max(1,Math.round((span.outputOut-span.outputIn)/duration*8))
   return Array.from({length:count},(_,i)=>({id:span.id,time:(span.sourceIn+(span.sourceOut-span.sourceIn)*(i+.5)/count)/1000}))
  })
  const images:Record<string,string[]>={}
  let index=0
  const seekNext=()=>{
   if(cancelled)return
   const sample=samples[index]
   if(sample)media.currentTime=sample.time
   else setFrames(images)
  }
  media.muted=true
  media.preload='auto'
  media.onloadeddata=seekNext
  media.onseeked=()=>{
   if(cancelled)return
   const sample=samples[index++]
   if(!sample)return
   context.drawImage(media,0,0,100,54)
   const strip=images[sample.id]??=[]
   strip.push(canvas.toDataURL('image/jpeg',.72))
   seekNext()
  }
  media.src=src
  return()=>{
   cancelled=true
   media.onseeked=null
   media.onloadeddata=null
   media.removeAttribute('src')
   media.load()
  }
 },[src,signature,duration])
 return <div className={`track-row ${hidden?'track-hidden':''}`}>
  <TrackLabel label="视频" hidden={hidden} onSelect={onSettings} onToggle={onToggle}/>
  <div className="timeline-lane track-filmstrip">{spans.map(span=><button key={span.id}
   className={selected===span.id?'selected':''} aria-label={`选择视频区间 ${ms(span.outputIn)} 至 ${ms(span.outputOut)}`}
   style={{width:`${(span.outputOut-span.outputIn)/duration*100}%`}}
   onClick={e=>{
    const bounds=e.currentTarget.getBoundingClientRect()
    const point=e.detail ? (e.clientX-bounds.left)/bounds.width : 0
    onSelect(span.id,span.outputIn+point*(span.outputOut-span.outputIn))
   }}>
   {frames[span.id]?.length ? frames[span.id].map((src,i)=><img key={i} src={src} alt="" draggable={false}/>) : <span>{ms(span.outputIn)} – {ms(span.outputOut)}</span>}
  </button>)}</div>
 </div>
}
