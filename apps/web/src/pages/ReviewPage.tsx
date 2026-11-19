import {ReviewMusic,MusicPreview,MusicTimeline,ReviewRange,Filmstrip} from './ReviewMusic'
import type {MusicTrack} from '../../../../packages/shared/music'
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api } from '../api'
import type { PackagingJob } from '../api'
import { AppShell } from '../layout/AppShell'
import { Alert, Badge, Empty } from '../ui/kit'
import { usePollProject } from '../lib/usePollProject'
import { useToast } from '../ui/toast'
import { BrandSetup } from '../components/BrandSetup'
import { clipDuration, outputToSource, sourceToOutput, timeMap, CHANNELS } from '../../../../packages/shared/editing'
import type { ChannelId } from '../../../../packages/shared/editing'
import { chineseOutput, outputSubtitles, packagingNeedsReview } from '../../../../packages/shared/packaging'
import type { Packaging, TextStyle } from '../../../../packages/shared/packaging'
import type { Clip, Project, FrameTemplate, ExportJob } from '../types'
import { ms } from '../lib/time'
import './ReviewPage.css'

type Side = 'title' | 'subtitle' | 'picture' | 'brand' | 'bgm'
export function ReviewPage() {
  const { id } = useParams(),
    nav = useNavigate(),
    toast = useToast()
  const { project, setProject, error, reload } = usePollProject(
    id,
    1200,
    (p) => !p.autoFrameRun || !['preparing', 'rendering'].includes(p.autoFrameRun.status),
  )
  const [selected, setSelected] = useState<string>('')
  const [batchJobs,setBatchJobs]=useState<ExportJob[]>([])
  useEffect(()=>{if(!project?.autoFrameRun)return;let alive=true;let timer:ReturnType<typeof setTimeout>;const tick=async()=>{try{const jobs=await api.exports(project.id);if(!alive)return;setBatchJobs(jobs.filter(j=>project.autoFrameRun!.previewJobIds.includes(j.id)));if(['preparing','rendering'].includes(project.autoFrameRun!.status))timer=setTimeout(tick,1200)}catch{if(alive)timer=setTimeout(tick,2500)}};void tick();return()=>{alive=false;clearTimeout(timer)}},[project?.id,project?.autoFrameRun?.jobId,project?.autoFrameRun?.status])

  if (error)
    return (
      <AppShell>
        <Alert kind="error">{error}</Alert>
      </AppShell>
    )
  if (!project)
    return (
      <AppShell>
        <p>正在读取项目…</p>
      </AppShell>
    )
  if (project.autoFrameRun?.status==='preparing')
    return (
      <AppShell>
        <div className="panel" style={{ padding: 32, maxWidth: 800, margin: '40px auto' }}>
          <h2>正在自动套框与包装</h2>
          <p>{project.autoFrameRun.message}</p>
          <p className="secondary">
            仅处理本次选中的 {project.autoFrameRun.clipIds.length}{' '}
            条；原包框和原声保留。完成后自动进入成片审核。
          </p>
        </div>
      </AppShell>
    )
  const clip = project.clips.find((c) => c.id === selected) ?? project.clips[0]
  if (!clip)
    return (
      <AppShell>
        <Empty
          title="没有可编辑片段"
          desc="先选择高光片段"
          action={
            <button className="btn" onClick={() => nav(`/projects/${id}/highlights`)}>
              返回筛选
            </button>
          }
        />
      </AppShell>
    )
  return (
    <ReviewWorkspace
      key={clip.id}
      batchJobs={batchJobs}
      project={project}
      clip={clip}
      onSelect={setSelected}
      onProject={setProject}
      reload={reload}
    />
  )
}
function ReviewWorkspace({
  batchJobs,
  project,
  clip,
  onSelect,
  onProject,
  reload,
}: {
  batchJobs:ExportJob[]
  project: Project
  clip: Clip
  onSelect: (id: string) => void
  onProject: (p: Project) => void
  reload: () => Promise<Project | null | undefined>
}) {
  const [volume, setVolume] = useState(1)
  const [previewSize, setPreviewSize] = useState('fit')
  const [selectedSpan, setSelectedSpan] = useState<string>()
  const [hiddenTracks, setHiddenTracks] = useState<string[]>([])
  const toggleTrack = (track: string) => setHiddenTracks(previous =>
    previous.includes(track) ? previous.filter(item => item !== track) : [...previous, track])
  const canvasZone = useRef<HTMLDivElement>(null)
  const [videoRange,setVideoRange]=useState<{start:number;end:number}|null>(null)
  const [musicTracks,setMusicTracks]=useState<MusicTrack[]>([])
  const nav = useNavigate(),
    toast = useToast()
  const tpl = project.brand?.template
  const [templates, setTemplates] = useState<FrameTemplate[]>([])
  const [fonts, setFonts] = useState<{ id: 'sans' | 'serif' | 'shuhei'; name: string }[]>([
    { id: 'sans', name: '系统中文黑体' },
  ])
  const [channelId, setChannelId] = useState<ChannelId>(project.brand?.channelId ?? 'technology')
  const [templateId, setTemplateId] = useState(project.templateId ?? '')
  const [confirmed, setConfirmed] = useState(false)
  const [mode, setMode] = useState<'body' | 'cover'>('body')
  const [side, setSide] = useState<Side>('bgm')
  const [p, setP] = useState<Packaging | null>(clip.packaging ?? null)
  const [cover, setCover] = useState(clip.cover)
  const [transform, setTransform] = useState(
    clip.transform ?? tpl?.defaultTransform ?? { scale: 1, offsetX: 0, offsetY: 0 },
  )
  const [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false)
  const [job, setJob] = useState<PackagingJob | null>(null)
  const [preview, setPreview] = useState<{ url: string; revision: number; poster?: string } | null>(null)
  const [rendering, setRendering] = useState(false),
    [showRender, setShowRender] = useState(false)
  const [time, setTime] = useState(0),
    [playing, setPlaying] = useState(false)
  const [frameTime, setFrameTime] = useState(0)
  const [layers, setLayers] = useState<{
    cover: string | null
    body: string | null
    subtitle: string | null
  }>({ cover: null, body: null, subtitle: null })
  const [layoutError, setLayoutError] = useState(''),
    [layerPending, setLayerPending] = useState(false)
  const backdropVideo = useRef<HTMLVideoElement>(null)
  const video = useRef<HTMLVideoElement>(null),
    upload = useRef<HTMLInputElement>(null)
  const mounted = useRef(true),
    renderGeneration = useRef(0)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      renderGeneration.current++
    }
  }, [])
  useEffect(() => {
    let alive = true
    Promise.all([api.templates(), api.textFonts(), api.packagingDraft(project.id, clip.id)])
      .then(([ts, fs, draft]) => {
        if (!alive) return
        setTemplates(ts)
        setFonts(fs)
        setP(draft)
      })
      .catch((e) => toast.push(e.message, 'error'))
    return () => {
      alive = false
    }
  }, [clip.id])
  useEffect(()=>{
    const job=batchJobs.filter(j=>j.clipId===clip.id&&j.status==='completed'&&j.editRevision===(clip.editPlan?.revision??0)).at(-1)
    if(job?.fileUrl&&!dirty&&mode==='body'&&preview?.url!==job.fileUrl){setPreview({url:job.fileUrl,revision:job.editRevision??0,poster:job.coverUrl});setShowRender(true)}
  },[clip.id,batchJobs.filter(j=>j.status==='completed').map(j=>j.id).join(',')])
  useEffect(() => {
    setConfirmed(false)
  }, [channelId, templateId])
  useEffect(() => {
    if (!p) return
    let alive = true
    setLayerPending(true)
    const timer = setTimeout(() => {
      api
        .textPreview(project.id, clip.id, p, time)
        .then((r) => {
          if (alive) {
            setLayers(r)
            setLayoutError('')
          }
        })
        .catch((e) => {
          if (alive) {
            setLayers({ cover: null, body: null, subtitle: null })
            setLayoutError(e.message)
          }
        })
        .finally(() => {
          if (alive) setLayerPending(false)
        })
    }, 250)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [p, time, clip.editPlan?.revision])
  useEffect(() => {
    if (!job || !['queued', 'processing'].includes(job.status)) return
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    const tick = async () => {
      try {
        const next = await api.packagingJob(job.id)
        if (!alive) return
        setJob(next)
        if (next.status === 'completed' || next.status === 'failed') {
          const updated = await reload()
          if (!alive) return
          const current = updated?.clips.find((c) => c.id === clip.id)
          if (current?.packaging) setP(structuredClone(current.packaging))
          setDirty(false)
          if (next.status === 'failed') toast.push(next.message, 'error')
          return
        }
        timer = setTimeout(tick, 1200)
      } catch (e: any) {
        if (alive) toast.push(e.message, 'error')
      }
    }
    timer = setTimeout(tick, 600)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [job?.id, job?.status])
  const generating = !!job && ['queued', 'processing'].includes(job.status)
  const duration = clipDuration(clip),
    spans = clip.editPlan?.spans ?? [{ id: 'legacy', sourceIn: clip.start, sourceOut: clip.end }]
  const captions = p && clip.editPlan ? chineseOutput(p, clip.editPlan) : []
  const timelineCaptions = p ? outputSubtitles({ ...clip, packaging: p, subtitleMode: 'zh' }) : []
  const mappedSpans = timeMap(spans)
  const selectedVideo = mappedSpans.find(span => span.id === selectedSpan)
  const active = captions.find((c) => time >= c.start && time < c.end)
  const change = (fn: (draft: Packaging) => void) => {
    if (!p) return
    const next = structuredClone(p)
    fn(next)
    setP(next)
    setDirty(true)
    setShowRender(false)
  }
  const replaceClip = (c: Clip) =>
    onProject({ ...project, clips: project.clips.map((x) => (x.id === c.id ? c : x)) })
  const save = async () => {
    if (!p) return null
    setBusy(true)
    try {
      const r = await api.savePresentation(project.id, clip.id, {
        packaging: p,
        cover,
        transform,
        expectedRevision: clip.editPlan?.revision,
      })
      replaceClip(r.clip)
      setP(r.clip.packaging ?? p)
      setDirty(false)
      return r.clip
    } catch (e: any) {
      toast.push(e.message, 'error')
      return null
    } finally {
      setBusy(false)
    }
  }
  const editTimeline = async (command: Record<string, unknown>) => {
    const saved = dirty ? await save() : clip
    if (!saved) return
    setBusy(true)
    try {
      const { clip: updated } = await api.clipOp(project.id, clip.id, {
        ...command,
        expectedRevision: saved.editPlan?.revision,
      })
      replaceClip(updated)
      setP(updated.packaging ?? p)
      setCover(updated.cover)
      setTransform(updated.transform ?? tpl?.defaultTransform ?? { scale: 1, offsetX: 0, offsetY: 0 })
      setVideoRange(null)
      setSelectedSpan(undefined)
      setPreview(null)
      setShowRender(false)
      setTime(0)
      if (video.current) {
        video.current.pause()
        video.current.currentTime = updated.start / 1000
      }
    } catch (error) {
      toast.push((error as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }
  const splitAt = Math.round(time)
  const splitSpan = mappedSpans.find(span => splitAt > span.outputIn && splitAt < span.outputOut)
  const splitVideo = () => {
    if (!splitSpan) return
    const point = splitSpan.sourceIn + splitAt - splitSpan.outputIn
    void editTimeline({ type: 'spans', spans: spans.flatMap(span => span.id === splitSpan.id
      ? [{ ...span, sourceOut: point }, { id: crypto.randomUUID(), sourceIn: point, sourceOut: span.sourceOut }]
      : [span]) })
  }
  const copyVideo = async () => {
    const saved = dirty ? await save() : clip
    if (!saved) return
    setBusy(true)
    try {
      const copy = await api.copyReviewClip(project.id, clip.id, {
        expectedRevision: saved.editPlan?.revision,
        start: selectedVideo?.outputIn ?? 0,
        end: selectedVideo?.outputOut ?? duration,
      })
      onProject(copy.project)
      onSelect(copy.clipId)
      toast.push('已复制为新片段', 'success')
    } catch (error) {
      toast.push((error as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }
  const applyBgmToAll = async () => {
    if (!p?.bgm) return
    const saved = dirty ? await save() : clip
    if (!saved) return
    setBusy(true)
    try {
      const next = await api.applyReviewBgm(project.id, {
        clipId: clip.id,
        expectedRevision: saved.editPlan?.revision,
        bgm: p.bgm,
      })
      onProject(next)
      setShowRender(false)
      toast.push(`已将 BGM 应用到 ${next.clips.length} 条片段`, 'success')
    } catch (error) {
      toast.push((error as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }
  const generate = async (all = false, cueId?: string) => {
    if (dirty && !(await save())) return
    setBusy(true)
    try {
      setJob(await api.generatePackaging(project.id, all ? project.clips.map((c) => c.id) : [clip.id], cueId))
      setPreview(null)
    } catch (e: any) {
      toast.push(e.message, 'error')
    } finally {
      setBusy(false)
    }
  }
  const render = async () => {
    const saved = await save()
    if (!saved) return
    const generation = ++renderGeneration.current
    setRendering(true)
    setShowRender(false)
    try {
      const r = await api.exportClips(project.id, {
          clipIds: [clip.id],
          ratio: 'fit',
          resolution: '720P',
          withSubtitles: true,
          exportCover: true,
          preview: true,
        }),
        id = r.jobs[0]?.id
      if (!id) throw Error('预览任务未创建')
      const deadline = Date.now() + 20 * 60 * 1000
      while (mounted.current && generation === renderGeneration.current) {
        const j = (await api.exports(project.id)).find((x) => x.id === id)
        if (j?.status === 'failed') throw Error(j.message)
        if (j?.status === 'completed') {
          setPreview({ url: j.fileUrl!, revision: saved.editPlan?.revision ?? 0, poster:j.coverUrl })
          setShowRender(true)
          break
        }
        if (Date.now() > deadline) throw Error('预览等待超时，请稍后重试')
        await new Promise((r) => setTimeout(r, 1000))
      }
    } catch (e: any) {
      if (mounted.current) toast.push(e.message, 'error')
    } finally {
      if (mounted.current) setRendering(false)
    }
  }
  const select = (id: string) => {
    if (dirty) {
      toast.push('请先保存当前修改，再切换片段', 'error')
      return
    }
    if (generating) {
      toast.push('请等待本次包装完成', 'error')
      return
    }
    onSelect(id)
  }
  const seek = (t: number) => {
    t = Math.max(0, Math.min(duration, t))
    setTime(t)
    if (video.current) video.current.currentTime = showRender && preview && !dirty && !hiddenTracks.length && preview.revision === clip.editPlan?.revision ? t / 1000 : outputToSource(spans, t) / 1000
  }
  const setCoverPatch = (patch: Partial<NonNullable<Clip['cover']>>) => {
    const base = cover ?? {
      source: 'frame' as const,
      frameTime: clip.start,
      imageUrl: null,
      title: clip.title,
      titleStyle: { fontSize: 64, color: '#FFFFFF', weight: 700, x: 0.5, y: 0.18, align: 'center' as const },
      firstScreenDuration: 0,
    }
    setCover({ ...base, ...patch })
    setDirty(true)
    setShowRender(false)
  }
  const grab = async () => {
    if (dirty && !(await save())) return
    setBusy(true)
    try {
      const r = await api.coverFrame(project.id, clip.id, outputToSource(spans, frameTime))
      replaceClip(r.clip)
      setCover(r.cover)
      setDirty(false)
    } catch (e: any) {
      toast.push(e.message, 'error')
    } finally {
      setBusy(false)
    }
  }
  const batchStyle = async () => {
    if (!p) return
    setBusy(true)
    try {
      const result = await api.batchPackagingStyle(project.id, clip.id, {
        coverStyle: p.coverStyle,
        bodyStyle: p.bodyStyle,
        subtitleStyle: p.subtitleStyle,finalSubtitleStyle:p.finalSubtitleStyle,
        expectedRevision: clip.editPlan?.revision,
      })
      onProject(result)
      setDirty(false)
      toast.push('已应用文字样式，保留各片独立文本', 'success')
    } catch (e: any) {
      toast.push(e.message, 'error')
    } finally {
      setBusy(false)
    }
  }
  const bind = async () => {
    if (dirty && !(await save())) return
    setBusy(true)
    try {
      const next = await api.bindBrand(project.id, {
        channelId,
        templateId,
        confirmed: true,
        expectedRevision: project.brand?.revision ?? 0,
      })
      onProject(next)
      setConfirmed(false)
      setPreview(null)
      toast.push('已绑定所选品牌，开始自动套框与包装', 'success')
      if(project.autoFrameRun?.previewJobIds.length)await api.resumeAutoFrame(project.id);else await api.autoFrame(project.id)
      await reload()
    } catch (e: any) {
      toast.push(e.message, 'error')
    } finally {
      setBusy(false)
    }
  }
  const vp = p?.frameLayout?.bodyViewport ?? tpl?.videoViewport
  const changedPreview = dirty || (!!preview && preview.revision !== (clip.editPlan?.revision ?? 0))
  return (
    <AppShell
      fullWidth
      crumbs={
        <>
          <button className="btn btn-ghost btn-sm" aria-label="返回项目" onClick={() => nav(`/projects/${project.id}`)}>←</button>
          <span className="pack-project-label">长视频智能切片</span>
          <span>/</span>
          <span className="pack-project-title" title={project.title}>{project.title}</span>
          <span>/</span>
          <b>成片确认</b>
        </>
      }
      topbarRight={
        <>
          <span className={`tiny pack-save-state ${dirty ? 'muted' : ''}`}>{dirty ? '有未保存修改' : '✓ 已保存'}</span>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => nav(`/projects/${project.id}/editor/${clip.id}`)}
          >
            返回剪辑
          </button>
          <button className="btn btn-secondary btn-sm" onClick={save} disabled={busy || generating}>
            保存当前设置
          </button>
          <button
            className="btn btn-primary btn-sm"
            disabled={busy || generating}
            onClick={async () => {
              if (await save()) nav(`/projects/${project.id}/export`)
            }}
          >
            确认 {project.clips.length} 条并进入导出
          </button>
        </>
      }
    >
      {project.autoFrameRun?.status === 'failed' && (
        <Alert kind="error">
          自动套框未完成：{project.autoFrameRun.message}{' '}
          <button
            className="btn btn-sm btn-secondary"
            onClick={async () => {
              try {
                if(project.autoFrameRun?.previewJobIds.length)await api.resumeAutoFrame(project.id);else await api.autoFrame(project.id)
                await reload()
              } catch (e: any) {
                toast.push(e.message, 'error')
              }
            }}
          >
            重试自动套框
          </button>
        </Alert>
      )}
      {project.autoFrameRun?.status==='rendering'&&<div className="alert alert-info" style={{marginBottom:10}}>
        已完成 {batchJobs.filter(j=>j.status==='completed').length} / {project.autoFrameRun.clipIds.length} 条，可先播放已完成片段。
        {batchJobs.filter(j=>j.status==='rendering').map(j=><span key={j.id}> 正在渲染「{j.clipTitle}」：{j.progress}%</span>)}
        {batchJobs.some(j=>j.status==='queued')&&<span> · 另有 {batchJobs.filter(j=>j.status==='queued').length} 条排队</span>}
      </div>}
      <div className="pack-workspace">
        <aside className="panel pack-clips">
          <div className="panel-head">
            <b>片段</b>
            <span className="tiny muted">{project.clips.length}</span>
          </div>
          <div className="scroll-y pack-clip-list">
            {project.clips.map((c, i) => (
              <button
                key={c.id}
                className={`pack-clip ${c.id === clip.id ? 'on' : ''}`}
                aria-current={c.id === clip.id ? true : undefined}
                onClick={() => select(c.id)}
              >
                <span className="pack-clip-thumb" aria-hidden="true">
                  {c.cover?.imageUrl ? <img src={c.cover.imageUrl} alt="" loading="lazy" /> :
                    <video src={`/files/uploads/${project.fileName}#t=${(c.editPlan?.spans[0]?.sourceIn ?? c.start) / 1000}`} preload="metadata" muted playsInline />}
                  <span>▶</span>
                </span>
                <span className="pack-clip-details">
                <span className="tiny muted">
                  {i + 1} · {ms(clipDuration(c))}
                </span>
                <b>{c.packaging?.coverTitle || c.title}</b>
                <span className="pack-clip-status tiny muted">
                  {!c.packaging
                    ? '待中文包装'
                    : packagingNeedsReview(c.packaging, c.editPlan)
                      ? '字幕待核对'
                      : '已包装'}
                </span>
                </span>
              </button>
            ))}
          </div>
        </aside>
        <div className="pack-center">
        <section className="panel pack-stage">
          <div className="panel-head">
            <button
              className={`chip ${mode === 'body' ? 'on' : ''}`}
              onClick={() => {
                setMode('body')
                setShowRender(false)
              }}
            >
              视频正文
            </button>
            <button
              className={`chip ${mode === 'cover' ? 'on' : ''}`}
              onClick={() => {
                setMode('cover')
                setShowRender(false)
              }}
            >
              封面
            </button>
            <span className="spacer" />
            <span className="pack-template-name tiny muted">
              {CHANNELS.find((c) => c.id === project.brand?.channelId)?.name ?? '待确认频道'} ·{' '}
              {tpl?.name ?? '待选包框'}
            </span>
            <button className="btn btn-secondary btn-sm" onClick={() => setSide('brand')}>更换模板</button>
          </div>
          <div className={`pack-canvas-zone preview-${previewSize}`} ref={canvasZone}>
            {showRender && preview && !changedPreview && !hiddenTracks.length ? (
              <video id={`review-video-${clip.id}`} ref={video} onLoadedMetadata={e => { e.currentTarget.volume = volume }} onTimeUpdate={e=>setTime(e.currentTarget.currentTime*1000)} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} className="pack-rendered" src={preview.url} poster={preview.poster} playsInline autoPlay />
            ) : tpl && vp ? (
              <div
                className="pack-canvas"
                style={{ aspectRatio: `${tpl.canvas.width}/${tpl.canvas.height}`, '--pack-aspect': tpl.canvas.width / tpl.canvas.height } as CSSProperties}
              >
                {mode === 'cover' && cover?.imageUrl ? <img className="pack-backdrop" src={cover.imageUrl} /> :
                  <video ref={backdropVideo} className="pack-backdrop" hidden={hiddenTracks.includes('视频')} src={`/files/uploads/${project.fileName}`} muted playsInline />}
                <div
                  className="pack-viewport"
                  style={{
                    left: `${(vp.x / tpl.canvas.width) * 100}%`,
                    top: `${(vp.y / tpl.canvas.height) * 100}%`,
                    width: `${(vp.width / tpl.canvas.width) * 100}%`,
                    height: `${(vp.height / tpl.canvas.height) * 100}%`,
                  }}
                >
                  <video
                    id={`review-video-${clip.id}`}
                    ref={video}
                    src={`/files/uploads/${project.fileName}`}
                    style={{
                      width: '100%',
                      height: '100%',
                      visibility: hiddenTracks.includes('视频') ? 'hidden' : undefined,
                      objectFit: p?.frameLayout?.fit??'cover',
                      transform: `translate(${(transform.offsetX / vp.width) * 100}%,${(transform.offsetY / vp.height) * 100}%) scale(${transform.scale})`,
                    }}
                    playsInline
                    onLoadedMetadata={e => { e.currentTarget.volume = volume; seek(time) }}
                    onTimeUpdate={(e) => {
                      if(backdropVideo.current && Math.abs(backdropVideo.current.currentTime-e.currentTarget.currentTime)>.15)backdropVideo.current.currentTime=e.currentTarget.currentTime
                      const abs = e.currentTarget.currentTime * 1000,
                        t = sourceToOutput(spans, abs)
                      if (t === null) {
                        const next = spans.find((s) => s.sourceIn > abs)
                        if (next) e.currentTarget.currentTime = next.sourceIn / 1000
                        else {
                          e.currentTarget.pause()
                          setPlaying(false)
                          setTime(duration)
                        }
                      } else setTime(Math.round(t))
                    }}
                    onPlay={() => {setPlaying(true);if(backdropVideo.current){backdropVideo.current.currentTime=video.current?.currentTime??0;void backdropVideo.current.play().catch(()=>{})}}}
                    onPause={() => {setPlaying(false);backdropVideo.current?.pause()}}
                  />
                </div>
                {mode === 'cover' && cover?.imageUrl && (
                  <img
                    className="pack-layer"
                    src={cover.imageUrl}
                    alt="原有封面图片"
                    style={
                      p?.frameLayout
                        ? {
                            inset: 'auto',
                            left: `${(p.frameLayout.coverViewport.x / tpl.canvas.width) * 100}%`,
                            top: `${(p.frameLayout.coverViewport.y / tpl.canvas.height) * 100}%`,
                            width: `${(p.frameLayout.coverViewport.width / tpl.canvas.width) * 100}%`,
                            height: `${(p.frameLayout.coverViewport.height / tpl.canvas.height) * 100}%`,
                            objectFit: p?.frameLayout?.fit??'cover',
                          }
                        : undefined
                    }
                  />
                )}
                {mode === 'body' && !hiddenTracks.includes('标题字幕') && layers.body && (
                  <img
                    className="pack-layer pack-text-hit"
                    src={layers.body}
                    alt="正文中文标题" style={{zIndex:2}}
                    onClick={() => setSide('title')}
                  />
                )}
                {mode === 'body' && !hiddenTracks.includes('字幕') && layers.subtitle && (
                  <img
                    className="pack-layer pack-text-hit"
                    src={layers.subtitle}
                    alt="中文口播字幕" style={{zIndex:2}}
                    onClick={() => setSide('subtitle')}
                  />
                )}
                {mode === 'cover' && layers.cover && (
                  <img className="pack-layer" src={layers.cover} alt="封面中文标题" style={{zIndex:2}} />
                )}
                {(mode === 'body' ? tpl.bodyFrameUrl : tpl.coverFrameUrl) && (
                  <img
                    className="pack-layer pack-brand"
                    src={(mode === 'body' ? tpl.bodyFrameUrl : tpl.coverFrameUrl)!}
                    alt="原项目品牌包框"
                  />
                )}
                {p &&
                  (mode === 'cover'
                    ? (['coverStyle'] as const)
                    : (['bodyStyle', 'subtitleStyle'] as const)
                  ).map((key) => {
                    const visible =
                      key === 'coverStyle'
                        ? layers.cover
                        : key === 'bodyStyle'
                          ? !hiddenTracks.includes('标题字幕') && layers.body
                          : !hiddenTracks.includes('字幕') && layers.subtitle
                    if (!visible) return null
                    const style = key==='subtitleStyle'?(p.finalSubtitleStyle??p.subtitleStyle):p[key]
                    return (
                      <TextTarget
                        key={key}
                        style={style}
                        canvasW={tpl.canvas.width}
                        canvasH={tpl.canvas.height}
                        label={key === 'subtitleStyle' ? '拖动中文字幕' : '拖动中文标题'}
                        onSelect={() => setSide(key === 'subtitleStyle' ? 'subtitle' : 'title')}
                        onMove={(x, y) =>
                          change((d) => {
                            const style=key==='subtitleStyle'?(d.finalSubtitleStyle??d.subtitleStyle):d[key];style.x=x;style.y=y
                          })
                        }
                      />
                    )
                  })}
              </div>
            ) : (
              <div className="muted">请在右侧品牌面板选择原有包框</div>
            )}
          </div>
          <div className="pack-player">
            <div className="row pack-player-main">
              <button
                className="btn btn-sm btn-ghost pack-play-button"
                aria-label={playing ? '暂停' : '播放'}
                onClick={() => {
                  if (!video.current) return
                  if (!video.current.paused) video.current.pause()
                  else {
                    if (time >= duration) seek(0)
                    void video.current.play().catch(e => toast.push(e.message, 'error'))
                  }
                }}
              >{playing ? 'Ⅱ' : '▶'}</button>
              <span className="mono">{ms(time)} / {ms(duration)}</span>
              <span className="spacer" />
              <button className="btn btn-ghost btn-sm" aria-label={volume ? '静音' : '取消静音'} onClick={() => {
                const next = volume ? 0 : 1
                setVolume(next)
                if (video.current) video.current.volume = next
              }}>{volume ? '◖))' : '◖×'}</button>
              <input className="pack-volume" aria-label="预览音量" type="range" min={0} max={1} step={.01} value={volume} onChange={e => {
                const next = Number(e.target.value)
                setVolume(next)
                if (video.current) video.current.volume = next
              }}/>
              <select className="pack-preview-size" aria-label="预览缩放" value={previewSize} onChange={e => setPreviewSize(e.target.value)}>
                <option value="fit">{tpl ? (tpl.canvas.height > tpl.canvas.width ? '9:16' : tpl.canvas.height === tpl.canvas.width ? '1:1' : '16:9') : '适配'}</option>
                <option value="compact">缩小预览</option>
              </select>
              <button className="btn btn-ghost btn-sm" aria-label="切换全屏" onClick={() => {
                const action = document.fullscreenElement ? document.exitFullscreen() : canvasZone.current?.requestFullscreen()
                void action?.catch(error => toast.push(error.message, 'error'))
              }}>⛶</button>
            </div>
            <div className="row pack-render-tools">
              <button
                className="btn btn-secondary btn-sm"
                disabled={busy || rendering || generating}
                onClick={render}
              >
                {rendering ? '正在渲染…' : '保存并更新成片预览'}
              </button>
              {preview && !changedPreview && (
                <button className="btn btn-ghost btn-sm" onClick={() => setShowRender((v) => !v)}>
                  {showRender ? '返回参数示意' : '查看成片预览'}
                </button>
              )}
            </div>
            <p className="tiny muted">
              {showRender ? 'FFmpeg 实际成片' : '参数示意 · 保留原声 · 画面只呈现中文'}
              {changedPreview ? ' · 预览待更新' : ''}
              {layerPending ? ' · 文字排版中…' : ''}
            </p>
            {layoutError && <Alert kind="error">{layoutError}</Alert>}
          </div>
        </section>
          {p && <>
            <MusicPreview mediaId={`review-video-${clip.id}`} bgm={hiddenTracks.includes('BGM') ? undefined : p.bgm}
              track={musicTracks.find(t => t.id === p.bgm?.trackId)} rendered={!!(showRender && preview && !changedPreview && !hiddenTracks.length)}
              outputTime={source => sourceToOutput(spans, source)} mediaKey={`${showRender}:${changedPreview}:${!!hiddenTracks.length}:${clip.editPlan?.revision}`}/>
            <MusicTimeline duration={duration} value={p.bgm} time={time} onSeek={seek}
              onChange={v => change(d => { d.bgm = v })} track={musicTracks.find(t => t.id === p.bgm?.trackId)}
              hiddenTracks={hiddenTracks} onToggleTrack={toggleTrack} onMusicSelect={() => setSide('bgm')}
              onTitleSelect={() => {
                if (p.bodyMode === 'off') change(d => { d.bodyMode = 'all' })
                setSide('title')
              }} onSubtitleSelect={() => setSide('subtitle')}
              tools={<>
                <button disabled={busy || generating || (!dirty && !clip.editPlan?.undoCount)} onClick={() => void editTimeline({ type: 'undo' })} aria-label="撤销">↶</button>
                <button disabled={busy || generating || dirty || !clip.editPlan?.redoCount} onClick={() => void editTimeline({ type: 'redo' })} aria-label="重做">↷</button>
                <button disabled={busy || generating || !splitSpan} onClick={splitVideo}>✂ 分割</button>
                <button disabled={busy || generating || !selectedVideo || duration - (selectedVideo.outputOut - selectedVideo.outputIn) < 1000} onClick={() => {
                  if (selectedVideo) void editTimeline({ type: 'review_cut', mode: 'delete', start: selectedVideo.outputIn, end: selectedVideo.outputOut })
                }}>删除</button>
                <button disabled={busy || generating} onClick={() => {
                  if (!videoRange) {
                    setVideoRange(selectedVideo ? { start: selectedVideo.outputIn, end: selectedVideo.outputOut } : { start: 0, end: duration })
                  } else if (videoRange.start === 0 && videoRange.end === duration) {
                    setVideoRange(null)
                  } else void editTimeline({ type: 'review_cut', mode: 'trim', ...videoRange })
                }}>{videoRange ? '确认裁剪' : '裁剪'}</button>
                <button title="复制为新片段" disabled={busy || generating || (selectedVideo !== undefined && selectedVideo.outputOut - selectedVideo.outputIn < 1000)} onClick={() => void copyVideo()}>▣ 复制</button>
              </>}>
              <ReviewRange label="标题字幕" onSelect={() => setSide('title')} duration={duration}
                hidden={hiddenTracks.includes('标题字幕')} onToggle={() => toggleTrack('标题字幕')}
                range={p.titleRange ?? { start: 0, end: p.bodyMode === 'intro' ? Math.min(p.bodyIntroMs, duration) : duration }}
                onChange={r => change(d => { d.titleRange = r })}>{p.bodyTitle || '点击编辑标题'}</ReviewRange>
              {videoRange ? (
                <ReviewRange label="视频" onSelect={() => setSide('picture')} duration={duration} trimOnly
                  hidden={hiddenTracks.includes('视频')} onToggle={() => toggleTrack('视频')}
                  range={videoRange} onChange={setVideoRange}>拖动两端选择保留范围</ReviewRange>
              ) : (
                <Filmstrip duration={duration} hidden={hiddenTracks.includes('视频')} onToggle={() => toggleTrack('视频')}
                  src={`/files/uploads/${project.fileName}`} spans={mappedSpans} selected={selectedSpan}
                  onSettings={() => setSide('picture')} onSelect={(id, position) => { setSelectedSpan(id); seek(position) }}/>
              )}
              <ReviewRange label="字幕" onSelect={() => setSide('subtitle')} duration={duration}
                hidden={hiddenTracks.includes('字幕')} onToggle={() => toggleTrack('字幕')}
                range={p.subtitleRange ?? { start: 0, end: duration }}
                onChange={r => change(d => {
                  const before = d.subtitleRange ?? { start: 0, end: duration }
                  if (r.end - r.start === before.end - before.start) d.subtitleOffsetMs = (d.subtitleOffsetMs ?? 0) + r.start - before.start
                  d.subtitleRange = r
                })}>
                {timelineCaptions.map(cue => <span key={cue.id} className="track-cue" title={cue.text} style={{
                  left: `${(cue.start - (p.subtitleRange?.start ?? 0)) / ((p.subtitleRange?.end ?? duration) - (p.subtitleRange?.start ?? 0)) * 100}%`,
                  width: `${(cue.end - cue.start) / ((p.subtitleRange?.end ?? duration) - (p.subtitleRange?.start ?? 0)) * 100}%`,
                }}>{cue.text}</span>)}
              </ReviewRange>
            </MusicTimeline>
          </>}
        </div>
        <aside className="panel pack-properties">
          <div className="pack-tabs">
            {(
              [
                ['picture', '画面'],
                ['subtitle', '字幕'],
                ['brand', '品牌'],
                ['bgm', 'BGM'],
              ] as const
            ).map(([id, label]) => (
              <button key={id} className={`chip ${side === id || (id === 'subtitle' && side === 'title') ? 'on' : ''}`} onClick={() => setSide(id)}>
                {label}
              </button>
            ))}
          </div>
          <div className="scroll-y pack-controls">
            {(busy || generating) && (
              <p className="tiny secondary">{generating ? job?.message : '正在保存…'}</p>
            )}
            {job?.status === 'failed' && <Alert kind="error">{job.message} · 已完成译文保留，可重试。</Alert>}
            {!p ? (
              <p>正在读取文字设置…</p>
            ) : (
              <fieldset disabled={busy || generating} className="pack-fieldset">
                <ReviewMusic pid={project.id} cid={clip.id} duration={duration} value={p.bgm} visible={side==='bgm'} clipCount={project.clips.length} onApplyAll={applyBgmToAll} onLibrary={setMusicTracks} onChange={v=>change(d=>{d.bgm=v})}/>
                {(side === 'title' || side === 'subtitle') && (
                  <div className="pack-text-tabs">
                    <button className={`chip ${side === 'title' ? 'on' : ''}`} onClick={() => setSide('title')}>标题</button>
                    <button className={`chip ${side === 'subtitle' ? 'on' : ''}`} onClick={() => setSide('subtitle')}>口播字幕</button>
                  </div>
                )}
                {side === 'title' && (
                  <>
                    <h3 className="pack-heading">AI 标题 · 五个候选</h3>
                    <button className="btn btn-secondary btn-block" onClick={() => generate()}>
                      生成当前片段中文包装
                    </button>
                    <button className="btn btn-ghost btn-sm" onClick={() => generate(true)}>
                      批量生成全部 {project.clips.length} 条
                    </button>
                    <p className="tiny muted">DeepSeek 生成五个角度，推荐一个标题；封面与视频内共用文字。</p>
                    {p.candidates.map((c) => (
                      <button
                        key={c.id}
                        className={`pack-candidate ${p.selectedId === c.id ? 'on' : ''}`}
                        onClick={() =>
                          change((d) => {
                            d.selectedId = c.id
                            d.coverTitle = c.coverTitle
                            d.bodyTitle = c.coverTitle
                            d.titleLinked = true
                            d.coverLocked = true
                            d.bodyLocked = true
                          })
                        }
                      >
                        <b>{c.angle}{c.recommended ? " · 推荐" : ""}</b>
                        <span>{c.coverTitle}</span>
                        
                        <small>
                          依据：
                          {c.evidenceIds
                            .map((id) => p.sourceCues.find((s) => s.id === id)?.original)
                            .filter(Boolean)
                            .join(' / ')}
                        </small>
                      </button>
                    ))}
                    {p.recommendationReason && <p className="tiny muted">推荐理由：{p.recommendationReason}</p>}
                    <TextArea
                      label="封面与视频内共用标题"
                      value={p.coverTitle}
                      onChange={(value) => change((d) => {
                        d.coverTitle = value
                        d.bodyTitle = value
                        d.titleLinked = true
                        d.coverLocked = true
                        d.bodyLocked = true
                      })}
                    />
                    <div className="row">
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() =>
                          change((d) => {
                            d.coverLocked = false
                            d.bodyLocked = false
                          })
                        }
                      >
                        解除标题手工锁定
                      </button>
                    </div>
                    <label className="label">编辑样式</label>
                    <div className="row">
                      <button
                        className={`chip ${mode === 'cover' ? 'on' : ''}`}
                        onClick={() => setMode('cover')}
                      >
                        封面
                      </button>
                      <button
                        className={`chip ${mode === 'body' ? 'on' : ''}`}
                        onClick={() => setMode('body')}
                      >
                        正文
                      </button>
                    </div>
                    <StyleEditor
                      value={mode === 'cover' ? p.coverStyle : p.bodyStyle}
                      fonts={fonts}
                      onChange={(s) =>
                        change((d) => {
                          if (mode === 'cover') d.coverStyle = s
                          else d.bodyStyle = s
                        })
                      }
                    />
                    <label className="label">视频内标题显示</label>
                    <select
                      className="input"
                      value={p.bodyMode}
                      onChange={(e) =>
                        change((d) => {
                          d.bodyMode = e.target.value as Packaging['bodyMode']
                        })
                      }
                    >
                      <option value="all">全片显示</option>
                      <option value="intro">仅开头显示</option>
                      <option value="off">关闭</option>
                    </select>
                    {p.bodyMode === 'intro' && (
                      <Slider
                        label="正文标题时长"
                        value={p.bodyIntroMs}
                        min={1000}
                        max={Math.min(60000, duration)}
                        step={100}
                        onChange={(v) =>
                          change((d) => {
                            d.bodyIntroMs = v
                          })
                        }
                      />
                    )}
                  </>
                )}
                {side === 'subtitle' && (
                  <>
                    <h3 className="pack-heading">中文字幕</h3>
                    <p className="tiny muted">
                      原文仅供核对，不烧录到画面。换行表示分屏；选中文字后可设置高亮。分屏时间为显示估算。
                    </p>
                    {!p.sourceCues.length && (
                      <button className="btn btn-primary" onClick={() => generate()}>
                        生成并复核中文字幕
                      </button>
                    )}
                    {p.sourceCues
                      .filter((c) => spans.some((s) => c.start < s.sourceOut && c.end > s.sourceIn))
                      .map((c) => (
                        <div className={`pack-cue ${active?.sourceCueId === c.id ? 'on' : ''}`} key={c.id}>
                          <button
                            className="btn btn-ghost btn-sm"
                            onClick={() => {
                              const m = captions.find((x) => x.sourceCueId === c.id)
                              if (m) seek(m.start)
                            }}
                          >
                            {ms(captions.find((x) => x.sourceCueId === c.id)?.start ?? 0)} ·{' '}
                            {c.locked ? '手工锁定' : c.status === 'needs_review' ? '待核对' : '已复核'}
                          </button>
                          <details>
                            <summary className="tiny muted">原文对照</summary>
                            <p className="tiny secondary">{c.original}</p>
                          </details>
                          <textarea
                            aria-label="编辑中文字幕"
                            className="textarea"
                            rows={2}
                            value={c.text}
                            onSelect={(e) => {
                              const t = e.currentTarget
                              t.dataset.selection = t.value.slice(t.selectionStart, t.selectionEnd)
                            }}
                            onChange={(e) =>
                              change((d) => {
                                const x = d.sourceCues.find((s) => s.id === c.id)!
                                x.text = e.target.value
                                x.highlights = x.highlights.filter((h) => x.text.includes(h))
                                x.status = 'manual'
                                x.locked = true
                                x.acknowledged = true
                              })
                            }
                            onBlur={(e) => {
                              e.currentTarget.dataset.selection = e.currentTarget.value.slice(
                                e.currentTarget.selectionStart,
                                e.currentTarget.selectionEnd,
                              )
                            }}
                          />
                          {c.issues.length > 0 && (
                            <p className="tiny" style={{ color: 'var(--accent)' }}>
                              {c.issues.join('；')}
                            </p>
                          )}
                          <div className="row" style={{ flexWrap: 'wrap' }}>
                            <button
                              className="btn btn-ghost btn-sm"
                              onClick={(e) => {
                                const textarea = e.currentTarget
                                    .closest('.pack-cue')
                                    ?.querySelector('textarea'),
                                  text = textarea?.dataset.selection?.trim()
                                if (text)
                                  change((d) => {
                                    const x = d.sourceCues.find((s) => s.id === c.id)!
                                    x.highlights = [...new Set([...x.highlights, text])]
                                  })
                              }}
                            >
                              高亮选中文字
                            </button>
                            <button
                              className="btn btn-ghost btn-sm"
                              onClick={() =>
                                change((d) => {
                                  d.sourceCues.find((s) => s.id === c.id)!.highlights = []
                                })
                              }
                            >
                              取消高亮
                            </button>
                            <button
                              className="btn btn-ghost btn-sm"
                              onClick={() => {
                                if (c.locked) {
                                  toast.push('请先解除本句锁定再重译', 'error')
                                  return
                                }
                                void generate(false, c.id)
                              }}
                            >
                              单句重译复核
                            </button>
                            <button
                              className="btn btn-ghost btn-sm"
                              onClick={() =>
                                change((d) => {
                                  const x = d.sourceCues.find((s) => s.id === c.id)!
                                  x.locked = !x.locked
                                })
                              }
                            >
                              {c.locked ? '解除锁定' : '锁定'}
                            </button>
                          </div>
                          {c.status === 'needs_review' && (
                            <label className="tiny">
                              <input
                                type="checkbox"
                                checked={!!c.acknowledged}
                                onChange={(e) =>
                                  change((d) => {
                                    d.sourceCues.find((s) => s.id === c.id)!.acknowledged = e.target.checked
                                  })
                                }
                              />{' '}
                              已对照原文并回听核对该疑点
                            </label>
                          )}
                        </div>
                      ))}
                    <StyleEditor
                      value={p.finalSubtitleStyle??p.subtitleStyle}
                      fonts={fonts}
                      onChange={(s) =>
                        change((d) => {
                          d.finalSubtitleStyle = s
                          d.subtitleLayoutVersion = 2
                        })
                      }
                    />
                  </>
                )}
                {side === 'picture' && (
                  <>
                    <h3 className="pack-heading">{mode === 'body' ? '正文构图' : '封面设置'}</h3>
                    <Slider
                      label="缩放比例"
                      value={transform.scale}
                      min={0.6}
                      max={1.6}
                      step={0.01}
                      onChange={(scale) => {
                        setTransform({ ...transform, scale })
                        setDirty(true)
                        setShowRender(false)
                      }}
                    />
                    <Slider
                      label="水平偏移 X"
                      value={transform.offsetX}
                      min={-400}
                      max={400}
                      step={1}
                      onChange={(offsetX) => {
                        setTransform({ ...transform, offsetX })
                        setDirty(true)
                        setShowRender(false)
                      }}
                    />
                    <Slider
                      label="垂直偏移 Y"
                      value={transform.offsetY}
                      min={-400}
                      max={400}
                      step={1}
                      onChange={(offsetY) => {
                        setTransform({ ...transform, offsetY })
                        setDirty(true)
                        setShowRender(false)
                      }}
                    />
                    <button
                      className="btn btn-secondary btn-block"
                      onClick={async () => {
                        const saved = await save()
                        if (!saved) return
                        setBusy(true)
                        try {
                          await api.patchFrame(project.id, clip.id, {
                            transform,
                            applyToAll: true,
                            expectedRevision: saved.editPlan?.revision,
                          })
                          await reload()
                          toast.push('已应用构图到全部片段', 'success')
                        } catch (e: any) {
                          toast.push(e.message, 'error')
                        } finally {
                          setBusy(false)
                        }
                      }}
                    >
                      将当前正文构图应用全部片段
                    </button>
                    <hr />
                    <Slider
                      label="抽帧位置（成片内）"
                      value={frameTime}
                      min={0}
                      max={Math.max(0, duration - 100)}
                      step={100}
                      onChange={setFrameTime}
                    />
                    <button className="btn btn-secondary btn-sm" onClick={grab}>
                      用该帧生成封面
                    </button>
                    <button className="btn btn-ghost btn-sm" onClick={() => upload.current?.click()}>
                      上传封面图片
                    </button>
                    <input
                      ref={upload}
                      type="file"
                      accept="image/*"
                      hidden
                      onChange={async (e) => {
                        const file = e.target.files?.[0]
                        e.target.value = ''
                        if (!file) return
                        setBusy(true)
                        try {
                          const a = await api.uploadAsset(file)
                          setCoverPatch({ source: 'upload', imageUrl: a.url })
                        } catch (err: any) {
                          toast.push(err.message, 'error')
                        } finally {
                          setBusy(false)
                        }
                      }}
                    />
                    <Slider
                      label="视频开头显示封面时长"
                      value={cover?.firstScreenDuration ?? 0}
                      min={0}
                      max={Math.min(3000, duration)}
                      step={100}
                      onChange={(v) => setCoverPatch({ firstScreenDuration: v })}
                    />
                    <p className="tiny muted">
                      首帧始终显示封面；此处可额外延长封面展示。封面文件独立导出。
                    </p>
                  </>
                )}
                {side === 'brand' && (
                  <>
                    <h3 className="pack-heading">频道与原有包框</h3>
                    <BrandSetup
                      channelId={channelId}
                      onChannel={setChannelId}
                      template={templates.find((t) => t.id === templateId) ?? null}
                      templates={templates}
                      onTemplate={setTemplateId}
                      confirmed={confirmed}
                      onConfirm={setConfirmed}
                    />
                    <select
                      className="input"
                      aria-label="选择原有模板"
                      value={templateId}
                      onChange={(e) => setTemplateId(e.target.value)}
                    >
                      <option value="">请选择包框模板</option>
                      {templates.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name} · v{t.version ?? 1}
                        </option>
                      ))}
                    </select>
                    <button className="btn btn-primary btn-block" disabled={!confirmed} onClick={bind}>
                      确认并应用全部切片
                    </button>
                    {p.channelId !== project.brand?.channelId && (
                      <p className="tiny">频道已变更，可重新生成标题；手工文本继续保留。</p>
                    )}
                  </>
                )}
              </fieldset>
            )}
            {p && (
              <div className="pack-batch">
                <button
                  className="btn btn-secondary btn-block"
                  disabled={busy || generating || dirty}
                  title={dirty ? '先保存修改后批量应用' : ''}
                  onClick={batchStyle}
                >
                  将文字样式应用全部 {project.clips.length} 条
                </button>
                <p className="tiny muted">不复制标题和字幕文本，不改原素材或品牌图片。</p>
              </div>
            )}
          </div>
        </aside>
      </div>
    </AppShell>
  )
}
function TextArea({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (v: string) => void
}) {
  return (
    <label className="pack-field">
      <span className="label">{label}</span>
      <textarea className="textarea" rows={3} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  )
}
function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
}) {
  return (
    <label className="pack-field">
      <span className="row">
        <span className="label">{label}</span>
        <span className="tiny mono" style={{ marginLeft: 'auto' }}>
          {value}
        </span>
      </span>
      <input
        style={{ width: '100%', accentColor: 'var(--accent)' }}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  )
}
function StyleEditor({
  value: s,
  fonts,
  onChange,
}: {
  value: TextStyle
  fonts: { id: 'sans' | 'serif' | 'shuhei'; name: string }[]
  onChange: (s: TextStyle) => void
}) {
  const patch = (p: Partial<TextStyle>) => onChange({ ...s, ...p })
  return (
    <div className="pack-style">
      <label className="pack-field">
        <span className="label">字体</span>
        <select
          className="input"
          value={s.font}
          onChange={(e) => patch({ font: e.target.value as TextStyle['font'] })}
        >
          {fonts.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      </label>
      <label className="pack-field">
        <span className="label">对齐</span>
        <select
          className="input"
          value={s.align}
          onChange={(e) => patch({ align: e.target.value as TextStyle['align'] })}
        >
          <option value="left">左对齐</option>
          <option value="center">居中</option>
          <option value="right">右对齐</option>
        </select>
      </label>
      <label className="pack-field">
        <span className="label">字重</span>
        <select
          className="input"
          value={s.weight}
          onChange={(e) => patch({ weight: Number(e.target.value) })}
        >
          <option value={400}>常规</option>
          <option value={600}>半粗</option>
          <option value={700}>粗体</option>
          <option value={900}>特粗</option>
        </select>
      </label>
      <label className="pack-field">
        <span className="label">字号（模板像素）</span>
        <input
          className="input"
          type="number"
          min={12}
          max={160}
          value={s.fontSize}
          onChange={(e) => patch({ fontSize: Number(e.target.value) })}
        />
      </label>
      <div className="row">
        <label className="tiny">
          文字颜色{' '}
          <input
            aria-label="文字颜色"
            type="color"
            value={s.color}
            onChange={(e) => patch({ color: e.target.value })}
          />
        </label>
        <label className="tiny">
          高亮颜色{' '}
          <input
            aria-label="高亮颜色"
            type="color"
            value={s.highlightColor}
            onChange={(e) => patch({ highlightColor: e.target.value })}
          />
        </label>
      </div>
      <Slider label="水平位置" value={s.x} min={0.05} max={0.95} step={0.01} onChange={(x) => patch({ x })} />
      <Slider label="垂直位置" value={s.y} min={0.02} max={0.95} step={0.01} onChange={(y) => patch({ y })} />
      <Slider
        label="文字区域宽度"
        value={s.width}
        min={0.2}
        max={0.96}
        step={0.01}
        onChange={(width) => patch({ width })}
      />
      <Slider
        label="行距"
        value={s.lineHeight}
        min={1}
        max={2}
        step={0.05}
        onChange={(lineHeight) => patch({ lineHeight })}
      />
      <label className="tiny">
        <input type="checkbox" checked={s.outline} onChange={(e) => patch({ outline: e.target.checked })} />{' '}
        黑色描边
      </label>
      {s.outline && <Slider label="描边粗细（模板像素）" value={s.outlineWidth ?? 8} min={0} max={30} step={1} onChange={(outlineWidth) => patch({ outlineWidth })} />}
      <label className="tiny">
        <input
          type="checkbox"
          checked={s.background}
          onChange={(e) => patch({ background: e.target.checked })}
        />{' '}
        字幕半透明底色
      </label>
    </div>
  )
}

function TextTarget({
  style,
  canvasW,
  canvasH,
  label,
  onSelect,
  onMove,
}: {
  style: TextStyle
  canvasW: number
  canvasH: number
  label: string
  onSelect: () => void
  onMove: (x: number, y: number) => void
}) {
  const drag = useRef<{
    x: number
    y: number
    clientX: number
    clientY: number
    width: number
    height: number
  } | null>(null)
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className="pack-text-target"
      style={{
        left: `${(style.x - style.width * (style.align === 'left' ? 0 : style.align === 'right' ? 1 : 0.5)) * 100}%`,
        top: `${style.y * 100}%`,
        width: `${style.width * 100}%`,
        height: `${Math.min(0.24, (style.fontSize * style.lineHeight * 3) / canvasH) * 100}%`,
      }}
      onPointerDown={(e) => {
        const rect = e.currentTarget.closest('.pack-canvas')!.getBoundingClientRect()
        drag.current = {
          x: style.x,
          y: style.y,
          clientX: e.clientX,
          clientY: e.clientY,
          width: rect.width,
          height: rect.height,
        }
        e.currentTarget.setPointerCapture(e.pointerId)
        onSelect()
      }}
      onPointerMove={(e) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId) || !drag.current) return
        const d = drag.current
        onMove(
          Math.max(0.05, Math.min(0.95, d.x + (e.clientX - d.clientX) / d.width)),
          Math.max(0.02, Math.min(0.95, d.y + (e.clientY - d.clientY) / d.height)),
        )
      }}
      onPointerUp={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
        drag.current = null
      }}
    />
  )
}
