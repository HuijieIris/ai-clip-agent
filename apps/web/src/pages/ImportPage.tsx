import { BrandSetup } from '../components/BrandSetup'
import type { ChannelId } from '../../../../packages/shared/editing'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import type { FrameTemplate, UploadedVideo } from '../types'
import { AppShell } from '../layout/AppShell'
import { Alert, Badge, Field, Modal, Progress } from '../ui/kit'
import {
  IconUpload, IconLink, IconFilm, IconPlus, IconFrame, IconCheck, IconX, IconLoader, IconTrash, IconChevronRight,
} from '../ui/icons'
import { bytes, dur, msLong } from '../lib/time'
import { useToast } from '../ui/toast'
import { FrameTemplateDialog } from './FrameTemplateDialog'

const RATIOS = [
  { value: '9:16', label: '竖屏 9:16' },
  { value: '16:9', label: '横屏 16:9' },
  { value: '1:1', label: '方形 1:1' },
  { value: '4:5', label: '竖版 4:5' },
]

export function ImportPage() {
  const nav = useNavigate()
  const toast = useToast()
  const [channelId,setChannelId]=useState<ChannelId>('technology')
  const [brandConfirmed,setBrandConfirmed]=useState(false)
  const [templates, setTemplates] = useState<FrameTemplate[]>([])
  const [loadingTpl, setLoadingTpl] = useState(true)
  const [selectedTpl, setSelectedTpl] = useState<string | null>(null)
  useEffect(()=>setBrandConfirmed(false),[channelId,selectedTpl])

  const [video, setVideo] = useState<UploadedVideo | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadErr, setUploadErr] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [urlMode, setUrlMode] = useState(false)
  const [url, setUrl] = useState('')
  const [progress, setProgress] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const [targetRatio, setTargetRatio] = useState('9:16')
  const [minSec, setMinSec] = useState(30)
  const [maxSec, setMaxSec] = useState(90)
  const [count, setCount] = useState(5)
  const [creating, setCreating] = useState(false)
  const [createErr, setCreateErr] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [tplPreviewTab, setTplPreviewTab] = useState<'cover' | 'body'>('body')

  const loadTemplates = useCallback(async () => {
    setLoadingTpl(true)
    try {
      const list = await api.templates()
      setTemplates(list)
      setSelectedTpl((cur) => cur ?? list[0]?.id ?? null)
    } catch (e: any) {
      toast.push(e.message, 'error')
    } finally {
      setLoadingTpl(false)
    }
  }, [toast])

  useEffect(() => {
    void loadTemplates()
  }, [loadTemplates])

  const doUpload = async (file: File) => {
    setUploadErr(null)
    const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
    if (!['mp4', 'mov', 'mkv', 'webm', 'm4v', 'avi'].includes(ext)) {
      setUploadErr(`不支持的格式 .${ext}，请上传 MP4 / MOV / MKV / WebM / M4V / AVI`)
      return
    }
    if (file.size > 2 * 1024 ** 3) {
      setUploadErr('文件超过 2GB 上限，请先压缩或分割后上传')
      return
    }
    setUploading(true)
    setProgress(0)
    const timer = setInterval(() => setProgress((p) => Math.min(88, p + Math.random() * 9)), 220)
    try {
      const res = await api.uploadVideo(file)
      setProgress(100)
      setVideo(res)
      toast.push(`已导入 ${res.originalName}`, 'success')
    } catch (e: any) {
      setUploadErr(e.message)
    } finally {
      clearInterval(timer)
      setUploading(false)
    }
  }

  const doUrl = async () => {
    if (!url.trim()) return
    setUploadErr(null)
    setUploading(true)
    setProgress(0)
    const timer = setInterval(() => setProgress((p) => Math.min(88, p + Math.random() * 7)), 260)
    try {
      const res = await api.uploadFromUrl(url.trim())
      setProgress(100)
      setVideo(res)
      toast.push('链接视频导入成功', 'success')
    } catch (e: any) {
      setUploadErr(e.message)
    } finally {
      clearInterval(timer)
      setUploading(false)
    }
  }

  // 导入后把切片时长区间收敛到视频实际长度，避免短视频被默认 30~90s 卡死
  useEffect(() => {
    if (!video) return
    const total = Math.floor(video.duration / 1000)
    if (total <= 0) return
    // 上限不超过视频总长；下限至少比上限小 1 秒，避免 min >= max 撞校验
    const max = Math.max(2, Math.min(90, total))
    setMaxSec(max)
    setMinSec(Math.max(1, Math.min(30, max - 1)))
  }, [video?.duration])

  const durationMs = video?.duration ?? 0
  const minMs = minSec * 1000
  const maxMs = maxSec * 1000
  const paramError =
    minMs >= maxMs
      ? '最短时长需小于最长时长'
      : video && maxMs > durationMs
        ? `最长时长 ${maxSec}s 超过视频总时长 ${Math.round(durationMs / 1000)}s`
        : null
  const canStart = brandConfirmed && !!video && !!selectedTpl && !paramError && count >= 1 && count <= 30

  const start = async () => {
    if (!video || !selectedTpl) return
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
        templateId: selectedTpl, channelId, brandConfirmed,
        targetRatio,
        minDuration: minMs,
        maxDuration: maxMs,
        desiredCount: count,
      })
      await api.analyze(p.id)
      nav(`/projects/${p.id}/analyzing`)
    } catch (e: any) {
      setCreateErr(e.message)
      setCreating(false)
    }
  }

  const tpl = templates.find((t) => t.id === selectedTpl) ?? null

  return (
    <AppShell
      topbarRight={
        <button className="btn btn-ghost btn-sm" onClick={() => nav('/projects')}>
          我的项目 <IconChevronRight size={14} />
        </button>
      }
    >
      <BrandSetup channelId={channelId} onChannel={setChannelId} template={tpl} templates={templates} onTemplate={setSelectedTpl} confirmed={brandConfirmed} onConfirm={setBrandConfirmed}/>
      <div style={{ maxWidth: 1420, margin: '0 auto' }}>
        <div className="row" style={{ marginBottom: 4, gap: 10 }}>
          <h1 className="h1">导入长视频</h1>
          <Badge kind="accent">第 1 步</Badge>
        </div>
        <p className="secondary sm" style={{ marginBottom: 22 }}>
          上传长视频、选一个固定视频包框，AI 会自动找到高光片段并切成短视频。
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: '38% 62%', gap: 18, alignItems: 'start' }}>
          {/* 左：上传 */}
          <div className="panel">
            <div className="panel-head">
              <IconFilm size={16} className="secondary" />
              <span className="card-title">视频来源</span>
              <div className="spacer" />
              <button className={`btn btn-sm ${urlMode ? 'btn-secondary' : 'btn-ghost'}`} onClick={() => setUrlMode((v) => !v)}>
                <IconLink size={13} /> 链接
              </button>
            </div>
            <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {!video && (
                <div
                  className={`dropzone ${dragging ? 'drag' : ''}`}
                  onClick={() => inputRef.current?.click()}
                  onDragOver={(e) => {
                    e.preventDefault()
                    setDragging(true)
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(e) => {
                    e.preventDefault()
                    setDragging(false)
                    const f = e.dataTransfer.files?.[0]
                    if (f) void doUpload(f)
                  }}
                >
                  {uploading ? (
                    <>
                      <IconLoader size={26} />
                      <div style={{ fontWeight: 600 }}>正在上传并校验…</div>
                      <div style={{ width: '80%' }}>
                        <Progress value={progress} />
                      </div>
                      <div className="tiny muted">上传完成后会自动读取时长与分辨率</div>
                    </>
                  ) : (
                    <>
                      <div className="empty-icon" style={{ width: 52, height: 52 }}>
                        <IconUpload size={22} />
                      </div>
                      <div style={{ fontWeight: 600, fontSize: 14.5 }}>拖放长视频到这里</div>
                      <div className="sm muted">或点击选择本地文件</div>
                      <div className="tiny muted" style={{ marginTop: 4 }}>
                        支持 MP4 / MOV / MKV / WebM · 最大 2GB
                      </div>
                    </>
                  )}
                </div>
              )}
              <input
                ref={inputRef}
                type="file"
                accept="video/*,.mkv,.m4v"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) void doUpload(f)
                  e.target.value = ''
                }}
              />

              {urlMode && !video && (
                <div className="row" style={{ gap: 8 }}>
                  <input
                    className="input"
                    placeholder="粘贴视频直链（https://…）"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && doUrl()}
                  />
                  <button className="btn btn-secondary" disabled={uploading || !url.trim()} onClick={doUrl}>
                    {uploading ? <IconLoader size={14} /> : '抓取'}
                  </button>
                </div>
              )}

              {video && (
                <div className="card card-pad" style={{ background: 'var(--bg-elevated)' }}>
                  <div className="row" style={{ alignItems: 'flex-start' }}>
                    <div
                      style={{
                        width: 46, height: 46, borderRadius: 10, background: 'rgba(201,255,77,.1)',
                        display: 'grid', placeItems: 'center', color: 'var(--accent)', flexShrink: 0,
                      }}
                    >
                      <IconFilm size={20} />
                    </div>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div className="row" style={{ gap: 6 }}>
                        <b style={{ fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {video.originalName}
                        </b>
                        <Badge kind="success">已校验</Badge>
                      </div>
                      <div className="tiny muted mono" style={{ marginTop: 3 }}>
                        {msLong(video.duration)} · {video.width}×{video.height} · {bytes(video.sizeBytes)}
                        {!video.hasAudio && ' · 无音轨'}
                      </div>
                      <div className="row" style={{ gap: 6, marginTop: 8 }}>
                        <button className="btn btn-sm btn-ghost" onClick={() => inputRef.current?.click()}>
                          重新选择
                        </button>
                        <button
                          className="btn btn-sm btn-ghost"
                          onClick={() => {
                            setVideo(null)
                            setProgress(0)
                          }}
                        >
                          移除
                        </button>
                      </div>
                    </div>
                  </div>
                  {!video.hasAudio && (
                    <div style={{ marginTop: 10 }}>
                      <Alert kind="warning">该视频没有音轨，无法进行语音识别与基于逐字稿的高光推荐。</Alert>
                    </div>
                  )}
                </div>
              )}

              {uploadErr && <Alert kind="error" title="无法导入">{uploadErr}</Alert>}
            </div>
          </div>

          {/* 右：模板 */}
          <div className="panel">
            <div className="panel-head">
              <IconFrame size={16} className="secondary" />
              <span className="card-title">视频包框模板</span>
              <div className="spacer" />
              <button className="btn btn-sm btn-secondary" onClick={() => setDialogOpen(true)}>
                <IconPlus size={13} /> 新建模板
              </button>
            </div>
            <div className="panel-body">
              {loadingTpl ? (
                <div className="row" style={{ justifyContent: 'center', padding: 40 }}>
                  <IconLoader size={20} />
                </div>
              ) : templates.length === 0 ? (
                <div className="empty">
                  <div className="empty-icon">
                    <IconFrame size={22} />
                  </div>
                  <div style={{ color: 'var(--text-primary)', fontWeight: 600 }}>还没有包框模板</div>
                  <div className="sm" style={{ maxWidth: 380 }}>
                    包框只需上传一次，保存后可对所有视频重复使用。封面包框与正文包框需要分别上传。
                  </div>
                  <button className="btn btn-secondary btn-sm" style={{ marginTop: 6 }} onClick={() => setDialogOpen(true)}>
                    <IconPlus size={13} /> 创建第一个模板
                  </button>
                </div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 300px', gap: 16 }}>
                  <div
                    style={{
                      display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(132px, 1fr))',
                      gap: 10, alignContent: 'start', maxHeight: 340, overflowY: 'auto', paddingRight: 4,
                    }}
                  >
                    {templates.map((t) => (
                      <div
                        key={t.id}
                        className={`tpl-card ${selectedTpl === t.id ? 'on' : ''}`}
                        onClick={() => setSelectedTpl(t.id)}
                        role="radio"
                        aria-checked={selectedTpl === t.id}
                        tabIndex={0}
                      >
                        <div className="tpl-thumbs">
                          <div className="tpl-thumb">
                            {t.coverFrameUrl && <img src={t.coverFrameUrl} alt="" />}
                            <span className="tpl-thumb-label">封面</span>
                          </div>
                          <div className="tpl-thumb">
                            {t.bodyFrameUrl && <img src={t.bodyFrameUrl} alt="" />}
                            <span className="tpl-thumb-label">正文</span>
                          </div>
                        </div>
                        <div className="row" style={{ gap: 6 }}>
                          <span style={{ fontSize: 12.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {t.name}
                          </span>
                          {selectedTpl === t.id && (
                            <span style={{ marginLeft: 'auto', color: 'var(--accent)', display: 'grid', placeItems: 'center' }}>
                              <IconCheck size={13} />
                            </span>
                          )}
                        </div>
                        <div className="tiny muted mono">
                          {t.canvas.width}×{t.canvas.height}
                        </div>
                      </div>
                    ))}
                    <button className="tpl-card" style={{ display: 'grid', placeItems: 'center', minHeight: 120, color: 'var(--text-muted)' }} onClick={() => setDialogOpen(true)}>
                      <div style={{ textAlign: 'center' }}>
                        <IconPlus size={18} />
                        <div className="tiny" style={{ marginTop: 4 }}>新建模板</div>
                      </div>
                    </button>
                  </div>

                  {/* 预览 */}
                  <div>
                    <div className="row" style={{ gap: 6, marginBottom: 10 }}>
                      <button
                        className={`chip ${tplPreviewTab === 'body' ? 'on' : ''}`}
                        onClick={() => setTplPreviewTab('body')}
                      >
                        正文包框
                      </button>
                      <button
                        className={`chip ${tplPreviewTab === 'cover' ? 'on' : ''}`}
                        onClick={() => setTplPreviewTab('cover')}
                      >
                        封面包框
                      </button>
                    </div>
                    {tpl ? (
                      <div style={{ display: 'flex', justifyContent: 'center' }}>
                        <div className="phone" style={{ maxWidth: 190 }}>
                          <div
                            className="phone-inner"
                            style={{
                              left: `${(tpl.videoViewport.x / tpl.canvas.width) * 100}%`,
                              top: `${(tpl.videoViewport.y / tpl.canvas.height) * 100}%`,
                              width: `${(tpl.videoViewport.width / tpl.canvas.width) * 100}%`,
                              height: `${(tpl.videoViewport.height / tpl.canvas.height) * 100}%`,
                              background: 'linear-gradient(150deg,#2a3340,#12161d)',
                              borderRadius: 4,
                            }}
                          >
                            <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: '#4b5563', fontSize: 10 }}>
                              {tplPreviewTab === 'body' ? '视频画面区' : ''}
                            </div>
                          </div>
                          <img
                            src={tplPreviewTab === 'body' ? tpl.bodyFrameUrl ?? '' : tpl.coverFrameUrl ?? ''}
                            alt=""
                            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', pointerEvents: 'none' }}
                          />
                        </div>
                      </div>
                    ) : (
                      <div className="tiny muted" style={{ textAlign: 'center', padding: 20 }}>选择左侧模板查看预览</div>
                    )}
                    {tpl && (
                      <div className="tiny muted" style={{ textAlign: 'center', marginTop: 10, lineHeight: 1.8 }}>
                        {tplPreviewTab === 'body' ? '正文包框叠加在视频画面之上' : '封面包框用于首屏与导出封面'}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* 底部参数栏 */}
        <div
          className="card"
          style={{
            marginTop: 18, padding: '16px 20px', display: 'flex', alignItems: 'flex-end', gap: 18, flexWrap: 'wrap',
            position: 'sticky', bottom: 0, background: 'var(--bg-surface)', zIndex: 5,
          }}
        >
          <div style={{ width: 150 }}>
            <Field label="目标比例">
              <select className="select input-sm" value={targetRatio} onChange={(e) => setTargetRatio(e.target.value)}>
                {RATIOS.map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
            </Field>
          </div>
          <div style={{ width: 108 }}>
            <Field label="最短时长(s)">
              <input
                className="input input-sm mono" type="number" min={5} max={600} value={minSec}
                onChange={(e) => setMinSec(Math.max(1, Number(e.target.value) || 1))}
              />
            </Field>
          </div>
          <div style={{ width: 108 }}>
            <Field label="最长时长(s)">
              <input
                className="input input-sm mono" type="number" min={5} max={1800} value={maxSec}
                onChange={(e) => setMaxSec(Math.max(2, Number(e.target.value) || 2))}
              />
            </Field>
          </div>
          <div style={{ width: 100 }}>
            <Field label="片段数量">
              <input
                className="input input-sm mono" type="number" min={1} max={30} value={count}
                onChange={(e) => setCount(Math.max(1, Math.min(30, Number(e.target.value) || 1)))}
              />
            </Field>
          </div>

          <div className="spacer" />

          {paramError && <div className="tiny" style={{ color: 'var(--warning)', maxWidth: 260 }}>{paramError}</div>}
          {createErr && <div className="tiny" style={{ color: 'var(--error)', maxWidth: 260 }}>{createErr}</div>}

          <button className="btn btn-primary btn-lg" disabled={!canStart || creating} onClick={start}>
            {creating ? <IconLoader size={16} /> : <IconFilm size={16} />}
            {creating ? '创建项目…' : '开始 AI 分析'}
          </button>
        </div>
        {!canStart && !creating && (
          <div className="tiny muted" style={{ textAlign: 'right', marginTop: 8 }}>
            {!video ? '请先导入视频' : !selectedTpl ? '请选择视频包框模板' : '请修正切片参数'}
          </div>
        )}
      </div>

      <FrameTemplateDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onCreated={(t) => {
          setDialogOpen(false)
          setSelectedTpl(t.id)
          void loadTemplates()
          toast.push(`模板「${t.name}」已保存并选中`, 'success')
        }}
      />
    </AppShell>
  )
}
