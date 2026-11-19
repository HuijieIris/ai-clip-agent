import { BrandSetup } from '../components/BrandSetup'
import type { ChannelId } from '../../../../packages/shared/editing'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import type { FrameTemplate, UploadedVideo } from '../types'
import { Alert, Badge, Modal } from '../ui/kit'
import {
  IconUpload, IconLink, IconFilm, IconPlus, IconFrame, IconLoader, IconX, IconChevronRight,
  IconSparkle, IconAlert, IconCheck, IconScissors, IconPlay,
} from '../ui/icons'
import { bytes, ms } from '../lib/time'
import { useToast } from '../ui/toast'
import { FrameTemplateDialog } from './FrameTemplateDialog'
import { RatioSelect, DurationSelect, CountSelect, type DurationRange } from '../ui/selects'
import { checkFrameFit, getRatio, resolveSize } from '../lib/ratios'
import { IconGrid } from '../ui/icons'

const CASES = [
  { tag: '知识', name: '三步把流程跑通', c1: '#7c3aed', c2: '#2563eb', t: '把流程跑通的\n三个步骤' },
  { tag: '播客', name: '为什么大多数人卡在第二步', c1: '#0f766e', c2: '#84cc16', t: '为什么卡在\n第二步' },
  { tag: '访谈', name: '完成比完美重要', c1: '#b45309', c2: '#f59e0b', t: '完成比\n完美重要' },
  { tag: '观点', name: '方法都是次要的', c1: '#be185d', c2: '#8b5cf6', t: '方法次要\n行动第一' },
  { tag: '科普', name: '数据说话的三个前提', c1: '#0369a1', c2: '#22d3ee', t: '数据说话\n的三个前提' },
]

const LAST_TPL_KEY = 'aiclip.lastTemplateId'

export function HomePage() {
  const nav = useNavigate()
  const toast = useToast()

  // 模板
  const [channelId,setChannelId]=useState<ChannelId>('technology')
  const [brandConfirmed,setBrandConfirmed]=useState(false)
  const [brandDialogOpen,setBrandDialogOpen]=useState(false)
  const [templates, setTemplates] = useState<FrameTemplate[]>([])
  const [tplId, setTplId] = useState<string | null>(null)
  useEffect(()=>setBrandConfirmed(false),[channelId,tplId])
  const [tplLoading, setTplLoading] = useState(true)
  const [dialogOpen, setDialogOpen] = useState(false)

  // 视频
  const [video, setVideo] = useState<UploadedVideo | null>(null)
  const [mode, setMode] = useState<'local' | 'url'>('local')
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState(0)
  const [err, setErr] = useState<string | null>(null)
  const [drag, setDrag] = useState(false)
  const [url, setUrl] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  // 创作参数
  const [duration, setDuration] = useState<DurationRange>({ min: 30, max: 120 })
  const [count, setCount] = useState<number | 'auto'>('auto')
  const [ratioId, setRatioId] = useState('fit')
  const [estimate, setEstimate] = useState<{ count: number; reason: string } | null>(null)
  const [creating, setCreating] = useState(false)
  const [createErr, setCreateErr] = useState<string | null>(null)

  const loadTemplates = useCallback(async () => {
    setTplLoading(true)
    try {
      const list = await api.templates()
      setTemplates(list)
      const saved = localStorage.getItem(LAST_TPL_KEY)
      const pick = list.find((t) => t.id === saved) ?? list[0]
      setTplId((cur) => cur ?? pick?.id ?? null)
    } catch (e: any) {
      toast.push(e.message, 'error')
    } finally {
      setTplLoading(false)
    }
  }, [toast])

  useEffect(() => {
    void loadTemplates()
  }, [loadTemplates])

  const tpl = templates.find((t) => t.id === tplId) ?? null
  const fit = useMemo(() => checkFrameFit(tpl, ratioId), [tpl, ratioId])

  // 视频时长变化 → 重算预估
  useEffect(() => {
    if (!video) {
      setEstimate(null)
      return
    }
    let alive = true
    api
      .estimateCount(video.duration, duration.min * 1000, duration.max * 1000)
      .then((r) => alive && setEstimate(r))
      .catch(() => alive && setEstimate(null))
    return () => {
      alive = false
    }
  }, [video?.duration, duration.min, duration.max])

  // 时长上限不得超过视频
  useEffect(() => {
    if (!video) return
    const maxAllowed = Math.floor(video.duration / 1000)
    if (duration.max > maxAllowed) {
      setDuration((d) => ({ min: Math.min(d.min, maxAllowed), max: maxAllowed }))
    }
  }, [video?.duration])

  const upload = async (file: File) => {
    setErr(null)
    const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
    if (!['mp4', 'mov', 'mkv', 'webm', 'm4v', 'avi'].includes(ext)) {
      setErr(`不支持的格式 .${ext}，请上传 MP4 / MOV / MKV / WebM / M4V / AVI`)
      return
    }
    if (file.size > 2 * 1024 ** 3) {
      setErr('文件超过 2GB，请先压缩或分割')
      return
    }
    setUploading(true)
    setProgress(0)
    const timer = setInterval(() => setProgress((p) => Math.min(88, p + Math.random() * 8)), 200)
    try {
      const res = await api.uploadVideo(file)
      setProgress(100)
      setVideo(res)
      // 默认时长若超出视频长度，收紧
      const maxAllowed = Math.floor(res.duration / 1000)
      if (maxAllowed < duration.max) {
        setDuration({ min: Math.min(duration.min, Math.max(5, maxAllowed - 5)), max: Math.max(10, maxAllowed) })
      }
      toast.push('视频已就绪', 'success')
    } catch (e: any) {
      setErr(e.message)
    } finally {
      clearInterval(timer)
      setUploading(false)
    }
  }

  const uploadFromUrl = async () => {
    if (!url.trim()) return
    setErr(null)
    setUploading(true)
    setProgress(0)
    const timer = setInterval(() => setProgress((p) => Math.min(88, p + Math.random() * 6)), 240)
    try {
      const res = await api.uploadFromUrl(url.trim())
      setProgress(100)
      setVideo(res)
      toast.push('链接视频已就绪', 'success')
    } catch (e: any) {
      setErr(e.message)
    } finally {
      clearInterval(timer)
      setUploading(false)
    }
  }

  const paramError = useMemo(() => {
    if (duration.min >= duration.max) return '最短时长需小于最长时长'
    if (video && duration.max * 1000 > video.duration) return `最长时长超过视频总时长 ${ms(video.duration)}`
    return null
  }, [duration.min, duration.max, video])

  const canStart = !!video && !!tplId && !paramError && fit.level !== 'error' && !creating

  const start = async () => {
    if (!video || !tplId) return
    if(!brandConfirmed){setBrandDialogOpen(true);return}
    setBrandDialogOpen(false)
    setCreating(true)
    setCreateErr(null)
    try {
      const p = await api.createProject({
        fileName: video.fileName,
        originalName: video.originalName,
        duration: video.duration,
        width: video.width,
        height: video.height,
        sizeBytes: video.sizeBytes,
        templateId: tplId, channelId, brandConfirmed,
        targetRatio: ratioId,
        minDuration: duration.min * 1000,
        maxDuration: duration.max * 1000,
        desiredCount: count === 'auto' ? 0 : count,
      })
      localStorage.setItem(LAST_TPL_KEY, tplId)
      await api.analyze(p.id)
      nav(`/projects/${p.id}/analyzing`)
    } catch (e: any) {
      setCreateErr(e.message)
      setCreating(false)
    }
  }

  const outSize = resolveSize(ratioId, '1080P')

  return (
    <div className="home-page">
      <div className="home-topbar">
        <div className="brand" style={{ padding: 0 }}>
          <div className="brand-mark">
            <IconScissors size={17} strokeWidth={2.2} />
          </div>
          <div>
            <div className="brand-name">AI 智能切片</div>
            <div className="brand-sub">长视频高光工作台</div>
          </div>
        </div>
        <div className="spacer" />
        <button className="btn btn-ghost btn-sm" onClick={() => nav('/dashboard')}>
          <IconGrid size={13} /> 工作台
        </button>
        <button className="btn btn-ghost btn-sm" onClick={() => nav('/templates')}>
          <IconFrame size={13} /> 我的模板
        </button>
        <button className="btn btn-ghost btn-sm" onClick={() => nav('/projects')}>
          我的项目 <IconChevronRight size={13} />
        </button>
      </div>
      <div className="home">
        <div className="home-hero">
          <h1 className="home-title">
            让长视频自动长出<em>高光切片</em>
          </h1>
          <p className="home-sub">AI 找到最值得传播的片段 · 套用你的固定包框 · 一次导出成片</p>
        </div>

        {/* 中央创作面板 */}
        <div className="create-panel">
          <div className="panel-tabs">
            <button className={`panel-tab ${mode === 'local' ? 'on' : ''}`} onClick={() => setMode('local')}>
              上传长视频
            </button>
            <button className={`panel-tab ${mode === 'url' ? 'on' : ''}`} onClick={() => setMode('url')}>
              粘贴视频链接
            </button>
          </div>

          {/* 上传区 */}
          {!video ? (
            <>
              {mode === 'local' ? (
                <div
                  className={`create-drop ${drag ? 'drag' : ''}`}
                  onClick={() => !uploading && fileRef.current?.click()}
                  onDragOver={(e) => {
                    e.preventDefault()
                    setDrag(true)
                  }}
                  onDragLeave={() => setDrag(false)}
                  onDrop={(e) => {
                    e.preventDefault()
                    setDrag(false)
                    const f = e.dataTransfer.files?.[0]
                    if (f) void upload(f)
                  }}
                >
                  {uploading ? (
                    <>
                      <div className="drop-icon">
                        <IconLoader size={24} />
                      </div>
                      <div style={{ fontWeight: 600, fontSize: 14.5 }}>正在上传并解析视频…</div>
                      <div style={{ width: 280, margin: '10px auto 0' }}>
                        <div className="progress">
                          <i style={{ width: `${progress}%` }} />
                        </div>
                      </div>
                      <div className="tiny muted" style={{ marginTop: 8 }}>上传完成后自动读取时长、分辨率与缩略图</div>
                    </>
                  ) : (
                    <>
                      <div className="drop-icon">
                        <IconUpload size={24} />
                      </div>
                      <div style={{ fontWeight: 600, fontSize: 15 }}>拖放长视频，或点击选择文件</div>
                      <div className="tiny muted" style={{ marginTop: 5 }}>
                        支持 MP4 / MOV / MKV / WebM / M4V / AVI · 最大 2GB
                      </div>
                    </>
                  )}
                </div>
              ) : (
                <div className="create-drop" style={{ cursor: 'default' }} onClick={(e) => e.stopPropagation()}>
                  {uploading ? (
                    <>
                      <div className="drop-icon">
                        <IconLoader size={24} />
                      </div>
                      <div style={{ fontWeight: 600, fontSize: 14.5 }}>正在抓取视频…</div>
                      <div style={{ width: 280, margin: '10px auto 0' }}>
                        <div className="progress">
                          <i style={{ width: `${progress}%` }} />
                        </div>
                      </div>
                    </>
                  ) : (
                    <div style={{ width: 'min(560px,100%)' }}>
                      <div className="drop-icon">
                        <IconLink size={24} />
                      </div>
                      <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 4 }}>粘贴视频直链</div>
                      <div className="tiny muted" style={{ marginBottom: 14 }}>
                        需要可访问的视频文件直链。平台页面链接需授权解析能力，当前版本请下载后上传
                      </div>
                      <div className="row" style={{ gap: 8 }}>
                        <input
                          className="input"
                          placeholder="https://example.com/video.mp4"
                          value={url}
                          onChange={(e) => setUrl(e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && uploadFromUrl()}
                          autoFocus
                        />
                        <button className="btn btn-primary" disabled={!url.trim()} onClick={uploadFromUrl}>
                          抓取
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
              <input
                ref={fileRef}
                type="file"
                accept="video/*,.mkv,.m4v"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) void upload(f)
                  e.target.value = ''
                }}
              />
            </>
          ) : (
            /* 已上传：缩略图 + 文件名 + 时长 */
            <div className="create-drop has">
              <div className="video-chip">
                <div className="video-thumb" onClick={() => nav('/projects')}>
                  {video.thumbnail ? (
                    <img src={video.thumbnail} alt="视频缩略图" />
                  ) : (
                    <div style={{ display: 'grid', placeItems: 'center', height: '100%', color: '#3f4a58' }}>
                      <IconFilm size={20} />
                    </div>
                  )}
                  <span className="thumb-dur mono">{ms(video.duration)}</span>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="row" style={{ gap: 7 }}>
                    <b style={{ fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {video.originalName}
                    </b>
                    <Badge kind="success">已就绪</Badge>
                    {!video.hasAudio && <Badge kind="warning">无音轨</Badge>}
                  </div>
                  <div className="tiny muted mono" style={{ marginTop: 4 }}>
                    {ms(video.duration)} · {video.width}×{video.height} · {bytes(video.sizeBytes)}
                  </div>
                  <div className="row" style={{ gap: 4, marginTop: 8 }}>
                    <button className="btn btn-sm btn-ghost" onClick={() => fileRef.current?.click()}>
                      更换视频
                    </button>
                    <button
                      className="btn btn-sm btn-ghost"
                      onClick={() => {
                        setVideo(null)
                        setProgress(0)
                        setErr(null)
                      }}
                    >
                      移除
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {err && (
            <div style={{ marginTop: 12 }}>
              <Alert kind="error" title="无法导入">{err}</Alert>
            </div>
          )}

          {/* 包框模板 */}
          <div style={{ marginTop: 14 }}>
            <div className="row" style={{ marginBottom: 7 }}>
              <span className="tiny muted">视频包框</span>
              <div className="spacer" />
              <button className="btn btn-sm btn-ghost" style={{ height: 24 }} onClick={() => setDialogOpen(true)}>
                <IconPlus size={11} /> 新建模板
              </button>
            </div>
            {tplLoading ? (
              <div className="row" style={{ padding: 10 }}>
                <IconLoader size={14} />
              </div>
            ) : templates.length === 0 ? (
              <button
                className="card"
                style={{ width: '100%', padding: 14, textAlign: 'left', borderStyle: 'dashed', background: 'transparent' }}
                onClick={() => setDialogOpen(true)}
              >
                <div className="row" style={{ gap: 8 }}>
                  <IconFrame size={15} className="muted" />
                  <span className="sm">还没有包框模板，先创建（封面与正文包框需分别上传）</span>
                  <IconChevronRight size={13} className="muted" style={{ marginLeft: 'auto' }} />
                </div>
              </button>
            ) : (
              <div className="frame-picker">
                <div className="row" style={{ gap: 4, flex: 1, overflowX: 'auto' }}>
                  {templates.map((t) => (
                    <button
                      key={t.id}
                      className={`frame-pick-item ${tplId === t.id ? 'on' : ''}`}
                      onClick={() => setTplId(t.id)}
                      title={`${t.name} · ${t.canvas.width}×${t.canvas.height}`}
                    >
                      <span className="frame-pick-thumb">
                        {t.bodyFrameUrl && <img src={t.bodyFrameUrl} alt="" />}
                      </span>
                      <span className="frame-pick-name">{t.name}</span>
                      {tplId === t.id && <IconCheck size={12} style={{ color: 'var(--accent)', flexShrink: 0 }} />}
                    </button>
                  ))}
                </div>
                <button className="btn btn-sm btn-ghost" style={{ height: 30 }} onClick={() => setDialogOpen(true)}>
                  <IconPlus size={11} />
                </button>
              </div>
            )}
            {tpl && (
              <div className="tiny muted mono" style={{ marginTop: 6 }}>
                画布 {tpl.canvas.width}×{tpl.canvas.height}
                {ratioId !== 'fit' && ` · 输出 ${outSize.w}×${outSize.h}`}
              </div>
            )}
          </div>

          {fit.level !== 'ok' && (
            <div className={`fit-warn ${fit.level === 'warn' ? 'warn' : ''}`} style={{ marginTop: 12 }}>
              <IconAlert size={13} style={{ flexShrink: 0, marginTop: 2 }} />
              <span>{fit.message}</span>
            </div>
          )}

          {/* 底部胶囊参数栏 */}
          <div className="pill-bar">
            <DurationSelect value={duration} onChange={setDuration} videoDuration={video?.duration ?? 0} />
            <RatioSelect value={ratioId} onChange={setRatioId} />
            <CountSelect value={count} onChange={setCount} autoEstimate={estimate} />

            <button
              className="start-btn"
              disabled={!canStart}
              onClick={start}
              title={
                !video ? '请先上传视频' : !tplId ? '请选择包框模板' : paramError ?? (fit.level === 'error' ? fit.message : '')
              }
            >
              {creating ? <IconLoader size={16} /> : <IconScissors size={16} />}
              {creating ? '创建中…' : '开始智能切片'}
            </button>
          </div>

          {!canStart && !creating && (
            <div className="tiny muted" style={{ marginTop: 9, textAlign: 'right' }}>
              {!video
                ? '请先上传或抓取一个有效视频'
                : !tplId
                  ? '请选择一个视频包框模板'
                  : paramError ?? (fit.level === 'error' ? '包框与所选比例不匹配' : '')}
            </div>
          )}

          {createErr && (
            <div style={{ marginTop: 10 }}>
              <Alert kind="error" title="创建项目失败">{createErr}</Alert>
            </div>
          )}
        </div>

        {/* 精选案例 */}
        <div className="cases">
          <div className="cases-head">
            <h2 style={{ fontSize: 17, fontWeight: 700 }}>精选案例</h2>
            <span className="tiny muted">同样的包框，不同的高光</span>
            <div className="spacer" />
            <button className="btn btn-ghost btn-sm" onClick={() => nav('/projects')}>
              查看我的项目 <IconChevronRight size={12} />
            </button>
          </div>
          <div className="case-grid">
            {CASES.map((c) => (
              <div key={c.name} className="case-card" onClick={() => toast.push('案例演示将在你完成第一个项目后展示同类效果', 'info')}>
                <div className="case-cover" style={{ background: `linear-gradient(150deg, ${c.c1}, ${c.c2})` }}>
                  <div className="case-cover-title" style={{ whiteSpace: 'pre-line' }}>{c.t}</div>
                  <span
                    style={{
                      position: 'absolute', right: 8, bottom: 8, width: 24, height: 24, borderRadius: '50%',
                      background: 'rgba(0,0,0,.42)', display: 'grid', placeItems: 'center', color: '#fff',
                    }}
                  >
                    <IconPlay size={9} />
                  </span>
                </div>
                <div className="case-meta">
                  <span className="case-tag">{c.tag}</span>
                  <span className="case-name">{c.name}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <Modal open={brandDialogOpen} title="确认任务频道与包框" onClose={()=>setBrandDialogOpen(false)} width={560}
        footer={<><button className="btn btn-secondary" onClick={()=>setBrandDialogOpen(false)}>返回</button><button className="btn btn-primary" disabled={!brandConfirmed||creating} onClick={start}>确认并开始</button></>}>
        <BrandSetup channelId={channelId} onChannel={setChannelId} template={tpl} templates={templates} onTemplate={setTplId} confirmed={brandConfirmed} onConfirm={setBrandConfirmed}/>
      </Modal>
      <FrameTemplateDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onCreated={(t) => {
          setDialogOpen(false)
          setTplId(t.id)
          localStorage.setItem(LAST_TPL_KEY, t.id)
          void loadTemplates()
          toast.push(`模板「${t.name}」已保存并选中`, 'success')
        }}
      />
    </div>
  )
}
