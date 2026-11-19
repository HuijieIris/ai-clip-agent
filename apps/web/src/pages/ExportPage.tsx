import { clipDuration } from '../../../../packages/shared/editing'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api } from '../api'
import { AppShell } from '../layout/AppShell'
import { Alert, Badge, Checkbox, Empty, Progress } from '../ui/kit'
import {
  IconDownload, IconLoader, IconRefresh, IconCheck, IconX, IconFilm, IconChevronLeft, IconImage, IconClock,
} from '../ui/icons'
import { ms } from '../lib/time'
import { usePollProject } from '../lib/usePollProject'
import { useToast } from '../ui/toast'
import type { ExportJob } from '../types'

const RATIOS = ['fit', '9:16', '16:9', '1:1', '4:5']
const RESOLUTIONS = ['720P', '1080P', '1440P']

export function ExportPage() {
  const { id } = useParams()
  const nav = useNavigate()
  const toast = useToast()
  const { project } = usePollProject(id, 60_000, () => true)
  const [jobs, setJobs] = useState<ExportJob[]>([])
  const [coverJobs, setCoverJobs] = useState<ExportJob[]>([])
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [ratio, setRatio] = useState('fit')
  const [resolution, setResolution] = useState('1080P')
  const [withSubtitles, setWithSubtitles] = useState(true)
  const [exportCover, setExportCover] = useState(true)
  const [busy, setBusy] = useState(false)
  const [zipping, setZipping] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const clips = project?.clips ?? []

  useEffect(() => {
    if (project && picked.size === 0) setPicked(new Set(project.clips.map((c) => c.id)))
  }, [project?.clips.length])

  useEffect(() => {
    if (!id) return
    const load = async () => {
      try {
        const list = await api.exports(id)
        setCoverJobs(list)
        setJobs(list.filter(j=>j.purpose!=='preview'))
        if (list.every((j) => j.status === 'completed' || j.status === 'failed')) {
          if (pollRef.current) {
            clearInterval(pollRef.current)
            pollRef.current = null
          }
        }
      } catch {}
    }
    void load()
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [id])

  const startPoll = () => {
    if (pollRef.current) return
    pollRef.current = setInterval(async () => {
      if (!id) return
      try {
        const list = await api.exports(id)
        setCoverJobs(list)
        setJobs(list.filter(j=>j.purpose!=='preview'))
        if (list.length && list.every((j) => j.status === 'completed' || j.status === 'failed')) {
          clearInterval(pollRef.current!)
          pollRef.current = null
        }
      } catch {}
    }, 1000)
  }

  const startExport = async () => {
    if (!project || picked.size === 0) return
    setBusy(true)
    try {
      await api.exportClips(project.id, {
        clipIds: [...picked],
        ratio,
        resolution,
        withSubtitles,
        exportCover,
      })
      toast.push(`已创建 ${picked.size} 个导出任务`, 'success')
      startPoll()
      const list = await api.exports(project.id)
      setCoverJobs(list)
        setJobs(list.filter(j=>j.purpose!=='preview'))
    } catch (e: any) {
      toast.push(e.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const retry = async (jobId: string) => {
    try {
      await api.retryExport(jobId)
      startPoll()
      toast.push('已重试该条导出')
    } catch (e: any) {
      toast.push(e.message, 'error')
    }
  }

  const done = jobs.filter((j) => j.status === 'completed')
  const running = jobs.some((j) => j.status === 'rendering' || j.status === 'queued')
  const failed = jobs.filter((j) => j.status === 'failed')

  const downloadZip = async () => {
    setZipping(true)
    try {
      const r = await api.downloadAll(done.map((j) => j.id))
      window.open(r.url, '_blank')
    } catch (e: any) {
      toast.push(e.message, 'error')
    } finally {
      setZipping(false)
    }
  }

  const clipJobs = useMemo(() => {
    return (project?.clips ?? []).map((c) => ({ clip: c, job: jobs.filter((j) => j.clipId === c.id).at(-1) }))
  }, [jobs, project?.clips.length])

  if (!project) {
    return <AppShell><div className="row" style={{ justifyContent: 'center', padding: 80 }}><IconLoader size={22} /></div></AppShell>
  }

  return (
    <AppShell
      crumbs={<><span>{project.title}</span><span style={{ opacity: 0.5 }}>/</span><b>批量导出</b></>}
      topbarRight={
        <>
          <button className="btn btn-ghost btn-sm" onClick={() => nav(`/projects/${project.id}/review`)}>
            <IconChevronLeft size={13} /> 返回套框确认
          </button>
          {done.length > 0 && (
            <button className="btn btn-secondary btn-sm" onClick={downloadZip} disabled={zipping}>
              {zipping ? <IconLoader size={13} /> : <IconDownload size={13} />} 打包下载 {done.length} 条
            </button>
          )}
        </>
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 330px', gap: 18, height: 'calc(100vh - 130px)' }}>
        {/* 左：预览卡 */}
        <div className="panel">
          <div className="panel-head">
            <IconFilm size={16} className="secondary" />
            <span className="card-title">待导出片段</span>
            <Badge kind="accent">{picked.size}/{clips.length}</Badge>
            <div className="spacer" />
            <button className="btn btn-sm btn-ghost" onClick={() => setPicked(picked.size === clips.length ? new Set() : new Set(clips.map((c) => c.id)))}>
              {picked.size === clips.length ? '取消全选' : '全选'}
            </button>
          </div>
          <div className="panel-body">
            {clips.length === 0 ? (
              <Empty title="没有可导出的片段" desc="请先在剪辑页保存片段" action={<button className="btn btn-secondary btn-sm" onClick={() => nav(`/projects/${project.id}/highlights`)}>返回筛选</button>} />
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12 }}>
                {clipJobs.map(({ clip, job }, i) => {
                  const on = picked.has(clip.id)
                  const coverJob = coverJobs.filter(j=>j.clipId===clip.id && j.status==='completed' && j.coverUrl && j.editRevision===clip.editPlan?.revision).sort((a,b)=>b.createdAt-a.createdAt)[0]
                  const coverImage = coverJob?.coverUrl
                  return (
                    <div
                      key={clip.id}
                      className={`card ${on ? '' : 'card-hover'}`}
                      style={{
                        padding: 10, cursor: 'pointer',
                        borderColor: on ? 'rgba(201,255,77,.45)' : undefined,
                        background: on ? 'rgba(201,255,77,.04)' : 'var(--bg-app)',
                      }}
                      onClick={() =>
                        setPicked((prev) => {
                          const n = new Set(prev)
                          n.has(clip.id) ? n.delete(clip.id) : n.add(clip.id)
                          return n
                        })
                      }
                    >
                      <div style={{ aspectRatio: ratio === 'fit' ? `${project?.brand?.template.canvas.width ?? 1080}/${project?.brand?.template.canvas.height ?? 1920}` : ratio.replace(':', '/'), borderRadius: 8, overflow: 'hidden', position: 'relative', background: '#05070a', border: '1px solid var(--border-soft)' }}>
                        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(150deg,#222b37,#0d1117)', display: 'grid', placeItems: 'center', color: '#3f4a58' }}>
                          <IconFilm size={20} />
                        </div>
                        <div style={{ position: 'absolute', left: 5, top: 5 }}>
                          <Checkbox on={on} />
                        </div>
                        {coverImage && (
                          <img src={coverImage} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain' }} />
                        )}
                        {!coverImage && <span className="tiny muted" style={{position:'absolute',inset:0,display:'grid',placeItems:'center'}}>封面预览生成中</span>}
                        <span className="badge" style={{ position: 'absolute', right: 5, bottom: 5, height: 17, fontSize: 9.5, background: 'rgba(0,0,0,.7)' }}>
                          {i + 1}
                        </span>
                      </div>
                      <div className="tiny" style={{ marginTop: 7, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {clip.title}
                      </div>
                      <div className="row tiny muted mono" style={{ gap: 6, marginTop: 2 }}>
                        <IconClock size={10} /> {(clipDuration(clip) / 1000).toFixed(1)}s
                      </div>
                      {job && (
                        <div style={{ marginTop: 7 }}>
                          {job.status === 'completed' ? (
                            <div className="row" style={{ gap: 5 }}>
                              <span className="badge badge-success" style={{ height: 18, fontSize: 10 }}><IconCheck size={9} /> 完成</span>
                              <a className="btn btn-sm btn-ghost" href={job.fileUrl} download style={{ height: 20, padding: '0 6px', fontSize: 10.5 }}>
                                <IconDownload size={10} /> MP4
                              </a>
                              {job.coverUrl && (
                                <a className="btn btn-sm btn-ghost" href={job.coverUrl} download style={{ height: 20, padding: '0 6px', fontSize: 10.5 }}>
                                  <IconImage size={10} /> 封面
                                </a>
                              )}
                            </div>
                          ) : job.status === 'failed' ? (
                            <div>
                              <div className="row" style={{ gap: 4 }}>
                                <span className="badge badge-error" style={{ height: 18, fontSize: 10 }}><IconX size={9} /> 失败</span>
                                <button className="btn btn-sm btn-ghost" style={{ height: 20, padding: '0 6px', fontSize: 10.5 }}
                                  onClick={(e) => { e.stopPropagation(); void retry(job.id) }}>
                                  重试
                                </button>
                              </div>
                              {job.message && (
                                <div className="tiny" style={{ color: 'var(--error)', marginTop: 3, fontSize: 9.5, lineHeight: 1.4, maxHeight: 34, overflow: 'hidden' }}>
                                  {job.message.slice(0, 80)}
                                </div>
                              )}
                            </div>
                          ) : (
                            <div>
                              <Progress value={job.progress} thin />
                              <div className="tiny muted mono" style={{ fontSize: 9.5, marginTop: 3 }}>
                                {job.status === 'queued' ? '排队中' : `渲染 ${job.progress}%`}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}

            {/* 汇总 */}
            {jobs.length > 0 && (
              <div style={{ marginTop: 18 }}>
                <div className="divider" style={{ marginBottom: 14 }} />
                <div className="row" style={{ gap: 16, marginBottom: 12 }}>
                  <span className="sm secondary">
                    共 {jobs.length} 个任务 · 成功 <b style={{ color: 'var(--success)' }}>{done.length}</b>
                    {failed.length > 0 && <> · 失败 <b style={{ color: 'var(--error)' }}>{failed.length}</b></>}
                    {running && <> · <span style={{ color: 'var(--accent)' }}>进行中…</span></>}
                  </span>
                  <div className="spacer" />
                  {running && <IconLoader size={13} />}
                </div>
                <div className="col" style={{ gap: 6 }}>
                  {jobs.map((j) => (
                    <div key={j.id} className="card" style={{ padding: '8px 12px', background: 'var(--bg-app)' }}>
                      <div className="row" style={{ gap: 8 }}>
                        <span className="tiny" style={{ width: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{j.clipTitle}</span>
                        <div style={{ flex: 1 }}>
                          <Progress value={j.status === 'completed' ? 100 : j.progress} thin />
                        </div>
                        <span className="tiny mono muted" style={{ width: 70, textAlign: 'right' }}>
                          {j.status === 'completed' ? '完成' : j.status === 'failed' ? '失败' : `${j.progress}%`}
                        </span>
                        {j.status === 'completed' && (
                          <a className="btn btn-sm btn-ghost" href={j.fileUrl} download style={{ height: 22, padding: '0 7px' }}>
                            <IconDownload size={11} />
                          </a>
                        )}
                        {j.status === 'failed' && (
                          <button className="btn btn-sm btn-ghost" style={{ height: 22, padding: '0 7px' }} onClick={() => retry(j.id)}>
                            <IconRefresh size={11} />
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* 右：配置 */}
        <div className="panel">
          <div className="panel-head">
            <IconFilm size={15} className="secondary" />
            <span className="card-title" style={{ fontSize: 14 }}>导出配置</span>
          </div>
          <div className="panel-body col" style={{ gap: 16 }}>
            <div className="field">
              <label className="label">画面比例</label>
              <div className="row wrap" style={{ gap: 6 }}>
                {RATIOS.map((r) => (
                  <button key={r} className={`chip ${ratio === r ? 'on' : ''}`} onClick={() => setRatio(r)}>{r === 'fit' ? '跟随包框（原始比例）' : r}</button>
                ))}
              </div>
            </div>
            <div className="field">
              <label className="label">清晰度</label>
              <div className="row wrap" style={{ gap: 6 }}>
                {RESOLUTIONS.map((r) => (
                  <button key={r} className={`chip ${resolution === r ? 'on' : ''}`} onClick={() => setResolution(r)}>{r}</button>
                ))}
              </div>
            </div>
            <div className="field">
              <label className="label">格式</label>
              <div className="row" style={{ gap: 6 }}>
                <span className="chip on">MP4 (H.264 + AAC)</span>
              </div>
            </div>

            <div className="divider" />

            <label className="row sm" style={{ gap: 8, cursor: 'pointer' }}>
              <input type="checkbox" checked={withSubtitles} onChange={(e) => setWithSubtitles(e.target.checked)} />
              烧录字幕到画面
            </label>
            <label className="row sm" style={{ gap: 8, cursor: 'pointer' }}>
              <input type="checkbox" checked={exportCover} onChange={(e) => setExportCover(e.target.checked)} />
              额外导出独立封面图
            </label>

            <div className="divider" />

            <div className="alert alert-info" style={{ fontSize: 12 }}>
              导出后即为成片文件，可直接下载。本产品不提供平台发布能力，不包含账号运营与投放。
            </div>

            <div className="spacer" />
            <button
              className="btn btn-primary btn-block"
              disabled={picked.size === 0 || busy}
              onClick={startExport}
            >
              {busy ? <IconLoader size={15} /> : <IconFilm size={15} />}
              批量导出 {picked.size} 条视频
            </button>
            <div className="tiny muted" style={{ textAlign: 'center' }}>
              服务端 ffmpeg 实际渲染，会套用模板包框与已编辑字幕
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  )
}
