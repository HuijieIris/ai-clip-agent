import { outputSubtitles, inferredSubtitleMode } from '../../../../packages/shared/packaging'
import type { SubtitleMode } from '../../../../packages/shared/packaging'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api } from '../api'
import { AppShell } from '../layout/AppShell'
import { Alert, Badge, Empty, Progress } from '../ui/kit'
import {
  IconPlay,
  IconPause,
  IconUndo,
  IconSend,
  IconLoader,
  IconSparkle,
  IconImage,
  IconUpload,
  IconScissors,
  IconClock,
  IconChevronRight,
  IconChevronLeft,
  IconLayers,
  IconFilm,
  IconRefresh,
  IconCheck,
} from '../ui/icons'
import { ms } from '../lib/time'
import { usePollProject } from '../lib/usePollProject'
import { useToast } from '../ui/toast'
import { clipDuration, outputToSource, sourceToOutput, timeMap } from '../../../../packages/shared/editing'
import type { Clip, TranscriptSegment } from '../types'

export function EditorPage() {
  const { id, clipId } = useParams()
  const nav = useNavigate()
  const toast = useToast()
  const { project, setProject, reload } = usePollProject(id, 60_000, () => true)
  const videoRef = useRef<HTMLVideoElement>(null)
  const [curMs, setCurMs] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [busy, setBusy] = useState(false)
  const [aiText, setAiText] = useState('')
  const [aiBusy, setAiBusy] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)
  const [aiSupported, setAiSupported] = useState<string[]>([])
  const [assetModal, setAssetModal] = useState<{ start: number; end: number } | null>(null)
  const [tab, setTab] = useState<'subtitle' | 'ops'>('subtitle')
  const [scriptOpen, setScriptOpen] = useState(true)

  const clips = project?.clips ?? []
  const clip = clips.find((c) => c.id === clipId) ?? clips[0]

  const source = project ? `/files/uploads/${project.fileName}` : ''
  const clipDur = clip ? clipDuration(clip) : 0
  const spans =
    clip?.editPlan?.spans ?? (clip ? [{ id: 'legacy', sourceIn: clip.start, sourceOut: clip.end }] : [])
  const seekOutput = (time: number) => {
    if (videoRef.current) videoRef.current.currentTime = outputToSource(spans, time) / 1000
  }

  const [subtitlePreparing, setSubtitlePreparing] = useState(false)
  const [subtitleError, setSubtitleError] = useState('')
  const [subtitleRetry, setSubtitleRetry] = useState(0)
  const [videoWidth, setVideoWidth] = useState(700)
  const subtitleMode = clip?.subtitleMode ?? (clip ? inferredSubtitleMode(clip) : 'zh')
  const foreign = clip ? inferredSubtitleMode(clip) === 'bilingual' : false
  const sourceKey = JSON.stringify(
    clip?.subtitles.map((c) => [c.sourceCueId ?? c.id, c.text, c.start, c.end]) ?? [],
  )
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const observer = new ResizeObserver(() => setVideoWidth(v.getBoundingClientRect().width))
    observer.observe(v)
    return () => observer.disconnect()
  }, [clip?.id])
  useEffect(() => {
    if (!project || !clip || !foreign) return
    if (
      clip.packaging?.subtitleLayoutVersion === 2 &&
      clip.packaging?.subtitleStyle.outlineWidth === 15 &&
      clip.subtitles.every((c) =>
        clip.packaging!.sourceCues.some((s) => s.id === c.sourceCueId && s.original === c.text),
      )
    ) {
      setSubtitlePreparing(false)
      setSubtitleError('')
      return
    }
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    setSubtitlePreparing(true)
    setSubtitleError('')
    const prepare = async () => {
      try {
        const job = await api.prepareSubtitles(project.id, clip.id)
        const poll = async () => {
          try {
            const status = await api.packagingJob(job.id)
            if (!alive) return
            if (status.status === 'failed') throw Error(status.message)
            if (status.status === 'completed') {
              await reload()
              if (alive) setSubtitlePreparing(false)
              return
            }
            timer = setTimeout(poll, 1000)
          } catch (e: any) {
            if (alive) {
              setSubtitlePreparing(false)
              setSubtitleError(e.message)
            }
          }
        }
        await poll()
      } catch (e: any) {
        if (alive) {
          setSubtitlePreparing(false)
          setSubtitleError(e.message)
        }
      }
    }
    void prepare()
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [clip?.id, sourceKey, subtitleRetry])
  const changeSubtitleMode = async (mode: SubtitleMode) => {
    if (!project || !clip) return
    setBusy(true)
    try {
      const r = await api.clipOp(project.id, clip.id, {
        type: 'subtitle_mode',
        mode,
        expectedRevision: clip.editPlan?.revision,
      })
      setProject((p) => (p ? { ...p, clips: p.clips.map((c) => (c.id === r.clip.id ? r.clip : c)) } : p))
    } catch (e: any) {
      toast.push(e.message, 'error')
    } finally {
      setBusy(false)
    }
  }
  const displayCue = clip ? outputSubtitles(clip).find((c) => curMs >= c.start && curMs < c.end) : undefined
  // 视频定位到片段内相对时间
  useEffect(() => {
    const v = videoRef.current
    if (!v || !clip) return
    v.currentTime = clip.start / 1000
    setCurMs(0)
  }, [clip?.id])

  useEffect(() => {
    const v = videoRef.current
    if (!v || !clip) return
    const onTime = () => {
      const abs = v.currentTime * 1000
      const mapped = sourceToOutput(spans, abs)
      if (mapped === null && abs < clip.end) {
        const next = spans.find((s) => s.sourceIn > abs)
        if (next) v.currentTime = next.sourceIn / 1000
        return
      }
      setCurMs(mapped ?? clipDur)
      if (abs >= clip.end) {
        v.pause()
        setPlaying(false)
        v.currentTime = clip.start / 1000
      }
    }
    v.addEventListener('timeupdate', onTime)
    return () => v.removeEventListener('timeupdate', onTime)
  }, [clip?.id, clip?.start, clip?.end, clip?.editPlan?.revision])

  const togglePlay = () => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) {
      if (v.currentTime * 1000 >= clip!.end - 50) v.currentTime = clip!.start / 1000
      void v.play()
      setPlaying(true)
    } else {
      v.pause()
      setPlaying(false)
    }
  }

  const applyTrim = async (start: number, end: number) => {
    if (!project || !clip) return
    const clampedStart = Math.max(0, Math.min(start, project.duration))
    const clampedEnd = Math.min(project.duration, Math.max(end, clampedStart + 1000))
    if (clampedEnd - clampedStart < 1000) {
      toast.push('片段至少 1 秒', 'error')
      return
    }
    setBusy(true)
    try {
      const r = await api.clipOp(project.id, clip.id, {
        expectedRevision: clip.editPlan?.revision,
        type: 'trim',
        start: Math.round(clampedStart),
        end: Math.round(clampedEnd),
      })
      setProject((p) => (p ? { ...p, clips: p.clips.map((c) => (c.id === r.clip.id ? r.clip : c)) } : p))
    } catch (e: any) {
      toast.push(e.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const undo = async (type: 'undo' | 'redo' = 'undo') => {
    if (!project || !clip) return
    setBusy(true)
    try {
      const r = await api.clipOp(project.id, clip.id, { type, expectedRevision: clip.editPlan?.revision })
      setProject((p) => (p ? { ...p, clips: p.clips.map((c) => (c.id === r.clip.id ? r.clip : c)) } : p))
      toast.push(type === 'undo' ? '已撤销上一步操作' : '已重做操作', 'success')
    } catch (e: any) {
      toast.push(e.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const saveSubtitle = async (cueId: string, text: string) => {
    if (!project || !clip) return
    try {
      const r = await api.clipOp(project.id, clip.id, {
        type: 'subtitle',
        cueId,
        text,
        expectedRevision: clip.editPlan?.revision,
      })
      setProject((p) => (p ? { ...p, clips: p.clips.map((c) => (c.id === r.clip.id ? r.clip : c)) } : p))
    } catch (e: any) {
      toast.push(e.message, 'error')
    }
  }

  const runAi = async () => {
    if (!project || !clip || !aiText.trim()) return
    setAiBusy(true)
    setAiError(null)
    setAiSupported([])
    try {
      const r = await api.nlEdit(project.id, clip.id, aiText.trim(), clip.editPlan?.revision)
      setProject((p) => (p ? { ...p, clips: p.clips.map((c) => (c.id === r.clip.id ? r.clip : c)) } : p))
      toast.push(r.summary, 'success')
      setAiText('')
    } catch (e: any) {
      setAiError(e.message)
      setAiSupported(e.payload?.supported ?? [])
    } finally {
      setAiBusy(false)
    }
  }

  const currentCue = useMemo(
    () => clip?.subtitles.find((c) => curMs >= c.start && curMs < c.end),
    [clip?.subtitles, curMs],
  )

  if (!project) {
    return (
      <AppShell>
        <div className="row" style={{ justifyContent: 'center', padding: 80 }}>
          <IconLoader size={22} />
        </div>
      </AppShell>
    )
  }
  if (!clip) {
    return (
      <AppShell>
        <Empty
          title="没有可编辑的片段"
          desc="请先在上一页选择高光片段"
          action={
            <button className="btn btn-secondary" onClick={() => nav(`/projects/${project.id}/highlights`)}>
              返回筛选
            </button>
          }
        />
      </AppShell>
    )
  }

  return (
    <AppShell
      crumbs={
        <>
          <span>{project.title}</span>
          <span style={{ opacity: 0.5 }}>/</span>
          <b>二次剪辑</b>
        </>
      }
      topbarRight={
        <>
          <div className="row" style={{ gap: 4 }}>
            {clips.map((c, i) => (
              <button
                key={c.id}
                className={`chip ${c.id === clip.id ? 'on' : ''}`}
                onClick={() => nav(`/projects/${project.id}/editor/${c.id}`)}
                title={c.title}
              >
                {i + 1}
                {c.status !== 'draft' && <span style={{ color: 'var(--success)' }}>●</span>}
              </button>
            ))}
          </div>
          <span className="tiny muted" style={{ marginLeft: 4 }}>
            {clips.findIndex((c) => c.id === clip.id) + 1}/{clips.length}
          </span>
          <button
            className="btn btn-primary btn-sm"
            disabled={busy || subtitlePreparing}
            onClick={async () => {
              setBusy(true)
              try {
                await api.autoFrame(project.id)
                nav(`/projects/${project.id}/review`)
              } catch (e: any) {
                toast.push(e.message, 'error')
                nav(`/projects/${project.id}/review`)
              } finally {
                setBusy(false)
              }
            }}
          >
            套框确认 <IconChevronRight size={13} />
          </button>
        </>
      }
    >
      {/* 三栏：左文稿字幕 / 中预览+分镜 / 右 AI 助手 */}
      <div className={`editor-grid ${scriptOpen ? '' : 'script-collapsed'}`}>
        {/* 左：文稿字幕 */}
        <div className="editor-col panel">
          <div className="panel-head">
            <IconScissors size={15} className="secondary" />
            <span className="card-title" style={{ fontSize: 14 }}>
              文稿字幕
            </span>
            <div className="spacer" />
            <button
              className="icon-btn"
              title={scriptOpen ? '收起字幕栏' : '展开字幕栏'}
              onClick={() => setScriptOpen((v) => !v)}
            >
              <IconChevronLeft
                size={14}
                style={{
                  transform: scriptOpen ? 'none' : 'rotate(180deg)',
                  transition: 'transform 160ms var(--ease)',
                }}
              />
            </button>
          </div>

          <div className="script-meta">
            <span className="mono">分镜总数 {clip.subtitles.length}</span>
            <span className="dot-sep">|</span>
            <span className="mono">总时长 {ms(clipDur)}</span>
          </div>

          <div className="scroll-y script-list">
            {clip.subtitles.length === 0 && (
              <div className="tiny muted" style={{ padding: 16, textAlign: 'center' }}>
                该片段没有字幕
              </div>
            )}
            {clip.subtitles.map((c, i) => {
              const active = curMs >= c.start && curMs < c.end
              return (
                <div
                  key={c.id}
                  className={`script-card ${active ? 'on' : ''}`}
                  onClick={() => {
                    const v = videoRef.current
                    if (v) seekOutput(c.start)
                  }}
                >
                  <div className="script-card-head">
                    <span className="script-index mono">分镜{String(i + 1).padStart(2, '0')}</span>
                    <span className="tiny muted mono" style={{ marginLeft: 'auto' }}>
                      {ms(c.start)}
                    </span>
                  </div>
                  <button
                    className="btn btn-sm btn-ghost"
                    disabled={busy}
                    onClick={async (e) => {
                      e.stopPropagation()
                      setBusy(true)
                      try {
                        const r = await api.clipOp(project.id, clip.id, {
                          type: 'delete_range',
                          start: c.start,
                          end: c.end,
                          expectedRevision: clip.editPlan?.revision,
                        })
                        setProject((p) =>
                          p ? { ...p, clips: p.clips.map((x) => (x.id === clip.id ? r.clip : x)) } : p,
                        )
                      } catch (err: any) {
                        toast.push(err.message, 'error')
                      } finally {
                        setBusy(false)
                      }
                    }}
                  >
                    删除本句音画
                  </button>
                  {foreign && (
                    <div className="tiny muted" style={{ padding: '4px 0' }}>
                      英文原文
                    </div>
                  )}
                  <textarea
                    aria-label={`字幕 ${i + 1}`}
                    className="script-text"
                    rows={Math.min(4, Math.max(1, Math.ceil(c.text.length / 12)))}
                    key={`${c.id}_${clip.editPlan?.revision}`}
                    defaultValue={c.text}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={(e) => {
                      if (e.target.value !== c.text) void saveSubtitle(c.id, e.target.value)
                    }}
                  />
                  {foreign && (
                    <>
                      <div className="tiny muted" style={{ padding: '4px 0' }}>
                        中文字幕
                      </div>
                      <textarea
                        className="script-text"
                        aria-label={`中文字幕 ${i + 1}`}
                        rows={2}
                        key={`zh_${c.id}_${clip.editPlan?.revision}`}
                        defaultValue={
                          clip.packaging?.sourceCues.find((s) => s.id === c.sourceCueId)?.text ?? ''
                        }
                        placeholder={subtitlePreparing ? '正在准备中文…' : '中文未就绪'}
                        onClick={(e) => e.stopPropagation()}
                        onBlur={async (e) => {
                          const original = clip.packaging?.sourceCues.find((s) => s.id === c.sourceCueId)
                          if (!original || e.target.value === original.text) return
                          const packaging = structuredClone(clip.packaging!)
                          const cue = packaging.sourceCues.find((s) => s.id === c.sourceCueId)!
                          cue.text = e.target.value
                          cue.status = 'manual'
                          cue.locked = true
                          cue.acknowledged = true
                          cue.highlights = cue.highlights.filter((t) => cue.text.includes(t))
                          try {
                            const r = await api.clipOp(project.id, clip.id, {
                              type: 'packaging',
                              packaging,
                              expectedRevision: clip.editPlan?.revision,
                            })
                            setProject((p) =>
                              p ? { ...p, clips: p.clips.map((x) => (x.id === r.clip.id ? r.clip : x)) } : p,
                            )
                          } catch (err: any) {
                            toast.push(err.message, 'error')
                          }
                        }}
                      />
                    </>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        {/* 中：预览 + 分镜条 */}
        <div className="editor-col">
          <div className="panel" style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
            {/* 顶部工具行 */}
            <div className="editor-toolbar">
              <button className="btn btn-sm btn-ghost" title="拖动时间轴裁剪">
                <IconScissors size={12} /> 编辑裁切
              </button>
              <button
                className="btn btn-sm btn-ghost"
                onClick={() =>
                  setAssetModal({ start: Math.max(0, curMs), end: Math.min(clipDur, curMs + 3000) })
                }
              >
                <IconImage size={12} /> 替换画面
              </button>
              {foreign && (
                <label
                  className="tiny"
                  style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 8 }}
                >
                  字幕语种
                  <select
                    aria-label="字幕语种"
                    className="input input-sm"
                    style={{ width: 135 }}
                    value={subtitleMode}
                    disabled={busy || subtitlePreparing}
                    onChange={(e) => void changeSubtitleMode(e.target.value as SubtitleMode)}
                  >
                    <option value="bilingual">中英双语</option>
                    <option value="zh">仅中文</option>
                    <option value="en">仅英文</option>
                  </select>
                </label>
              )}
              <div className="spacer" />
              <Badge>
                {clip.status === 'draft' ? '未编辑' : clip.status === 'edited' ? '已编辑' : '已套框'}
              </Badge>
            </div>

            {/* 视频 */}
            <div
              style={{
                background: '#05070a',
                position: 'relative',
                flex: 1,
                minHeight: 0,
                display: 'grid',
                placeItems: 'center',
                overflow: 'hidden',
              }}
            >
              <video
                ref={videoRef}
                src={source}
                style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
                onClick={togglePlay}
              />
              {displayCue?.text && (
                <div
                  className="editor-cue editor-bilingual-cue"
                  style={{
                    fontSize: Math.max(
                      11,
                      ((clip.packaging?.subtitleLayoutVersion === 2
                        ? clip.packaging.subtitleStyle.fontSize
                        : Math.min(32, clip.packaging?.subtitleStyle.fontSize ?? 32)) *
                        videoWidth) /
                        1080,
                    ),
                    WebkitTextStroke: `${(15 * videoWidth) / 1080}px #000`,
                    width: Math.min(videoWidth * 0.9, 950),
                  }}
                >
                  <div>{displayCue.text}</div>
                  {displayCue.english && (
                    <div style={{ fontSize: '.72em', marginTop: 6 }}>{displayCue.english}</div>
                  )}
                </div>
              )}
              {subtitlePreparing && (
                <span
                  className="tiny"
                  style={{
                    position: 'absolute',
                    top: 8,
                    left: 12,
                    background: 'var(--bg-surface)',
                    padding: 6,
                  }}
                >
                  正在准备并复核中文字幕，保留原声…
                </span>
              )}
              {!subtitlePreparing &&
                !subtitleError &&
                foreign &&
                subtitleMode !== 'en' &&
                !displayCue?.text && (
                  <button
                    className="btn btn-sm btn-secondary"
                    style={{ position: 'absolute', top: 8, left: 12 }}
                    onClick={() => setSubtitleRetry((x) => x + 1)}
                  >
                    准备中文字幕
                  </button>
                )}
              {subtitleError && (
                <div style={{ position: 'absolute', top: 8, left: 12, right: 12 }}>
                  <Alert kind="error">
                    {subtitleError}{' '}
                    <button className="btn btn-sm btn-ghost" onClick={() => setSubtitleRetry((x) => x + 1)}>
                      重试字幕
                    </button>
                  </Alert>
                </div>
              )}
            </div>

            {/* 播放条 */}
            <div className="player-bar">
              <button className="btn btn-sm btn-secondary" onClick={togglePlay}>
                {playing ? <IconPause size={12} /> : <IconPlay size={12} />}
              </button>
              <span className="tiny mono secondary">
                {ms(curMs)} / {ms(clipDur)}
              </span>
              <span className="tiny muted mono">
                原片 {ms(clip.start)} → {ms(clip.end)}
              </span>
              <div className="spacer" />
              <button
                className="btn btn-sm btn-ghost"
                onClick={() => void undo()}
                disabled={busy || !clip.editPlan?.undoCount}
                title="撤销上一步"
              >
                <IconUndo size={13} /> 撤销
              </button>
              <button
                className="btn btn-sm btn-ghost"
                disabled={busy || !clip.editPlan?.redoCount}
                onClick={() => void undo('redo')}
              >
                重做
              </button>
            </div>

            <div style={{ padding: '8px 14px' }} className="tiny secondary">
              保留 {spans.length} 段 ·{' '}
              {timeMap(spans)
                .map((s) => `${ms(s.sourceIn)}–${ms(s.sourceOut)}`)
                .join(' / ')}
              <br />
              原片快速预览会跳过删除区间；成片请在品牌页生成渲染预览。
            </div>
            {/* 裁剪时间轴 */}
            <div style={{ padding: '10px 14px 12px', borderTop: '1px solid var(--border-soft)' }}>
              <TrimTimeline
                total={project.duration}
                start={clip.start}
                end={clip.end}
                cur={curMs}
                busy={busy}
                onCommit={applyTrim}
                onSeek={(abs) => {
                  const v = videoRef.current
                  if (v) v.currentTime = abs / 1000
                }}
              />
              <div style={{ marginTop: 8 }}>
                <TrackRow label="字幕轨">
                  {clip.subtitles.map((c) => (
                    <div
                      key={c.id}
                      title={c.text}
                      style={{
                        position: 'absolute',
                        left: `${(c.start / clipDur) * 100}%`,
                        width: `${((c.end - c.start) / clipDur) * 100}%`,
                        top: 3,
                        bottom: 3,
                        background: 'rgba(85,214,156,.28)',
                        borderRadius: 3,
                        minWidth: 2,
                      }}
                    />
                  ))}
                </TrackRow>
                <TrackRow label="替换画面">
                  {clip.replacements.map((r) => (
                    <div
                      key={r.id}
                      title={`${r.assetName}（${r.keepAudio ? '保留原声' : '静音'}）`}
                      style={{
                        position: 'absolute',
                        left: `${(r.start / clipDur) * 100}%`,
                        width: `${((r.end - r.start) / clipDur) * 100}%`,
                        top: 3,
                        bottom: 3,
                        background: 'rgba(201,255,77,.3)',
                        borderRadius: 3,
                        minWidth: 2,
                      }}
                    />
                  ))}
                </TrackRow>
                <TrackRow label="原视频">
                  <div
                    style={{
                      position: 'absolute',
                      inset: 3,
                      background: 'rgba(169,178,192,.18)',
                      borderRadius: 3,
                    }}
                  />
                  <div
                    style={{
                      position: 'absolute',
                      left: `${(curMs / clipDur) * 100}%`,
                      top: 0,
                      bottom: 0,
                      width: 1.5,
                      background: '#fff',
                      zIndex: 3,
                    }}
                  />
                </TrackRow>
              </div>
            </div>

            {/* 分镜缩略图条 */}
            <div className="shot-strip">
              <div className="shot-strip-head">
                <IconFilm size={12} className="secondary" />
                <span className="tiny muted">分镜条</span>
                <div className="spacer" />
                <span className="tiny muted mono">{clip.subtitles.length} 段</span>
              </div>
              <div className="shot-strip-body">
                {clip.subtitles.map((c, i) => {
                  const active = curMs >= c.start && curMs < c.end
                  return (
                    <button
                      key={c.id}
                      className={`shot-card ${active ? 'on' : ''}`}
                      onClick={() => {
                        const v = videoRef.current
                        if (v) seekOutput(c.start)
                      }}
                      title={c.text}
                    >
                      <span className="shot-index mono">分镜{String(i + 1).padStart(2, '0')}</span>
                      <span className="shot-dur mono">{((c.end - c.start) / 1000).toFixed(1)}s</span>
                      {active && <span className="shot-playing">使用中</span>}
                    </button>
                  )
                })}
                {clip.subtitles.length === 0 && (
                  <span className="tiny muted" style={{ padding: '0 4px' }}>
                    没有分镜
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* 右：AI 助手 */}
        <div className="editor-col panel">
          <div className="panel-head">
            <IconSparkle size={15} style={{ color: 'var(--accent)' }} />
            <span className="card-title" style={{ fontSize: 14 }}>
              AI 剪辑助手
            </span>
          </div>

          <div
            className="scroll-y"
            style={{ flex: 1, padding: 12, display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0 }}
          >
            <div className="alert alert-info" style={{ fontSize: 12 }}>
              已接入大语言模型：将自然语言转换为可校验的编辑操作，成功后写入历史，可撤销。不支持或有歧义的请求会说明原因。
            </div>

            {clip.operations.length === 0 ? (
              <div className="tiny muted" style={{ textAlign: 'center', padding: 16 }}>
                还没有编辑操作
              </div>
            ) : (
              <div className="col" style={{ gap: 6 }}>
                {[...clip.operations].reverse().map((op) => (
                  <div
                    key={op.id}
                    className="card"
                    style={{
                      padding: '8px 10px',
                      background: 'var(--bg-app)',
                      opacity: op.applied ? 1 : 0.45,
                      fontSize: 12,
                    }}
                  >
                    <div className="row" style={{ gap: 6 }}>
                      <span
                        className={`badge ${op.applied ? 'badge-accent' : ''}`}
                        style={{ height: 17, fontSize: 10 }}
                      >
                        {op.type === 'trim'
                          ? '裁剪'
                          : op.type === 'subtitle'
                            ? '字幕'
                            : op.type === 'replace'
                              ? '换画面'
                              : op.type}
                      </span>
                      <span className="tiny muted mono" style={{ marginLeft: 'auto' }}>
                        {ms(op.at)}
                      </span>
                    </div>
                    <div className="secondary" style={{ marginTop: 3, lineHeight: 1.5 }}>
                      {op.summary}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {aiError && (
              <Alert kind="error" title="未识别该指令">
                {aiError}
                {aiSupported.length > 0 && (
                  <div className="row wrap" style={{ gap: 5, marginTop: 8 }}>
                    {aiSupported.map((s) => (
                      <button
                        key={s}
                        className="chip"
                        onClick={() => setAiText(s)}
                        style={{ height: 22, fontSize: 11 }}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                )}
              </Alert>
            )}
          </div>

          <div style={{ padding: 10, borderTop: '1px solid var(--border-soft)' }}>
            <div className="row" style={{ gap: 6 }}>
              <textarea
                className="textarea"
                rows={2}
                placeholder="例如：字幕缩小一点，并只显示中文"
                value={aiText}
                onChange={(e) => setAiText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    void runAi()
                  }
                }}
                style={{ fontSize: 12.5 }}
              />
              <button
                className="btn btn-primary"
                style={{ height: 46, width: 46, padding: 0 }}
                disabled={aiBusy || !aiText.trim()}
                onClick={runAi}
              >
                {aiBusy ? <IconLoader size={14} /> : <IconSend size={15} />}
              </button>
            </div>
          </div>
        </div>
      </div>
      {assetModal && (
        <ReplacePanel
          project={project}
          clip={clip}
          range={assetModal}
          onClose={() => setAssetModal(null)}
          onApplied={async () => {
            setAssetModal(null)
            await reload()
            toast.push('已替换指定区间画面，保留原声', 'success')
          }}
        />
      )}
    </AppShell>
  )
}

function TrackRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="row" style={{ gap: 8, marginBottom: 4 }}>
      <span className="tiny muted" style={{ width: 52, flexShrink: 0 }}>
        {label}
      </span>
      <div
        style={{
          flex: 1,
          height: 20,
          background: 'var(--bg-app)',
          borderRadius: 4,
          position: 'relative',
          overflow: 'hidden',
          border: '1px solid var(--border-soft)',
        }}
      >
        {children}
      </div>
    </div>
  )
}

function TrimTimeline({
  total,
  start,
  end,
  cur,
  busy,
  onCommit,
  onSeek,
}: {
  total: number
  start: number
  end: number
  cur: number
  busy: boolean
  onCommit: (s: number, e: number) => void
  onSeek: (abs: number) => void
}) {
  const barRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<{
    kind: 'start' | 'end' | 'move'
    x0: number
    s: number
    e: number
  } | null>(null)
  const [local, setLocal] = useState<{ s: number; e: number } | null>(null)
  const s = local?.s ?? start
  const e = local?.e ?? end

  // 可视窗口：以当前片段为中心向外留出余量，拖动缩放到合理范围。
  // 直接用整片时长做比例尺时，几十秒的片段在 2 小时视频里只占 0.5% 宽，手柄会挤成一团没法拖。
  const pad = Math.max(15000, (e - s) * 0.6)
  const viewStart = Math.max(0, Math.floor((s - pad) / 1000) * 1000)
  const viewEnd = Math.min(total, Math.ceil((e + pad) / 1000) * 1000)
  const view = Math.max(1000, viewEnd - viewStart)
  const pct = (abs: number) => ((abs - viewStart) / view) * 100

  const pxToMs = (dx: number) => {
    const w = barRef.current?.clientWidth ?? 1
    return (dx / w) * view
  }

  useEffect(() => {
    if (!drag) return
    const move = (ev: MouseEvent) => {
      const d = pxToMs(ev.clientX - drag.x0)
      if (drag.kind === 'start') {
        const ns = Math.max(0, Math.min(drag.e - 1000, drag.s + d))
        setLocal({ s: ns, e: drag.e })
      } else if (drag.kind === 'end') {
        const ne = Math.min(total, Math.max(drag.s + 1000, drag.e + d))
        setLocal({ s: drag.s, e: ne })
      } else {
        const dur = drag.e - drag.s
        const ns = Math.max(0, Math.min(total - dur, drag.s + d))
        setLocal({ s: ns, e: ns + dur })
      }
    }
    const up = () => {
      setLocal((l) => {
        if (l) onCommit(l.s, l.e)
        return null
      })
      setDrag(null)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
  }, [drag, total])

  return (
    <div>
      <div className="row" style={{ marginBottom: 6 }}>
        <span className="tiny muted">裁剪：拖动左右手柄调整区间（不创造原片不存在的内容）</span>
        <div className="spacer" />
        <span className="tiny mono" style={{ color: 'var(--accent)' }}>
          {(e - s) / 1000 < 0 ? '0' : ((e - s) / 1000).toFixed(1)}s
        </span>
        {busy && <IconLoader size={12} />}
      </div>
      <div
        className="timeline-track"
        ref={barRef}
        onMouseDown={(ev) => {
          const r = barRef.current!.getBoundingClientRect()
          onSeek(viewStart + ((ev.clientX - r.left) / r.width) * view)
        }}
      >
        <div
          className="tl-range"
          style={{ left: `${pct(s)}%`, width: `${((e - s) / view) * 100}%` }}
          onMouseDown={(ev) => {
            ev.stopPropagation()
            setDrag({ kind: 'move', x0: ev.clientX, s, e })
          }}
        />
        <div
          className="tl-handle"
          style={{ left: `calc(${pct(s)}% - 5px)` }}
          onMouseDown={(ev) => {
            ev.stopPropagation()
            setDrag({ kind: 'start', x0: ev.clientX, s, e })
          }}
        />
        <div
          className="tl-handle"
          style={{ left: `calc(${pct(e)}% - 5px)` }}
          onMouseDown={(ev) => {
            ev.stopPropagation()
            setDrag({ kind: 'end', x0: ev.clientX, s, e })
          }}
        />
        <div className="tl-playhead" style={{ left: `${pct(start + cur)}%` }} />
      </div>
      <div className="tl-ticks">
        <span>{ms(viewStart)}</span>
        <span>{ms(viewStart + view / 2)}</span>
        <span>{ms(viewStart + view)}</span>
      </div>
    </div>
  )
}

function AssetList({
  onPick,
  disabled,
  onUploaded,
}: {
  onPick: (assetId: string, name: string, url: string) => void
  disabled: boolean
  onUploaded: () => void
}) {
  const [items, setItems] = useState<{ id: string; name: string; url: string; kind: string }[]>([])
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)

  const load = async () => {
    try {
      const a = await api.assets()
      setItems(a)
    } catch {}
  }
  useEffect(() => {
    void load()
  }, [])

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 6 }}>
        {items
          .filter((i) => i.kind === 'image')
          .slice(0, 6)
          .map((a) => (
            <button
              key={a.id}
              className="tpl-thumb"
              disabled={disabled}
              style={{
                aspectRatio: '16/9',
                padding: 0,
                cursor: disabled ? 'not-allowed' : 'pointer',
                opacity: disabled ? 0.4 : 1,
              }}
              onClick={() => onPick(a.id, a.name, a.url)}
              title={a.name}
            >
              <img src={a.url} alt={a.name} />
            </button>
          ))}
        <button
          className="tpl-thumb"
          style={{ aspectRatio: '16/9', display: 'grid', placeItems: 'center', color: 'var(--text-muted)' }}
          onClick={() => fileRef.current?.click()}
        >
          {uploading ? <IconLoader size={14} /> : <IconUpload size={15} />}
          <div className="tiny" style={{ fontSize: 9, marginTop: 2 }}>
            上传
          </div>
        </button>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/*,video/*"
        hidden
        onChange={async (e) => {
          const f = e.target.files?.[0]
          e.target.value = ''
          if (!f) return
          setUploading(true)
          try {
            await api.uploadAsset(f)
            await load()
            onUploaded()
          } catch (err: any) {
            alert(err.message)
          } finally {
            setUploading(false)
          }
        }}
      />
    </div>
  )
}

function ReplacePanel({
  project,
  clip,
  range,
  onClose,
  onApplied,
}: {
  project: { id: string }
  clip: Clip
  range: { start: number; end: number }
  onClose: () => void
  onApplied: () => void
}) {
  const toast = useToast()
  const [start, setStart] = useState(range.start)
  const [end, setEnd] = useState(range.end)
  const [picked, setPicked] = useState<{ id: string; name: string; url: string } | null>(null)
  const [keepAudio, setKeepAudio] = useState(true)
  const [busy, setBusy] = useState(false)
  const clipDur = clipDuration(clip)

  const submit = async () => {
    if (!picked) {
      toast.push('请先选择一个素材', 'error')
      return
    }
    setBusy(true)
    try {
      await api.clipOp(project.id, clip.id, {
        expectedRevision: clip.editPlan?.revision,
        type: 'replace',
        replacement: {
          id: `rep_${Date.now()}`,
          start: Math.round(start),
          end: Math.round(end),
          assetId: picked.id,
          assetName: picked.name,
          assetUrl: picked.url,
          keepAudio,
        },
      })
      onApplied()
    } catch (e: any) {
      toast.push(e.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width: 'min(560px,100%)' }}>
        <div className="modal-head">
          <div className="h2" style={{ fontSize: 17 }}>
            替换指定区间画面
          </div>
        </div>
        <div className="modal-body col" style={{ gap: 14 }}>
          <Alert kind="info">替换只影响所选时间区间，其他画面和原说话音频保持不变。</Alert>
          <div className="grid-2">
            <div className="field">
              <label className="label">开始（秒，片段内相对）</label>
              <input
                className="input mono"
                type="number"
                step={0.1}
                min={0}
                max={clipDur / 1000}
                value={(start / 1000).toFixed(1)}
                onChange={(e) => setStart(Math.max(0, Number(e.target.value) * 1000))}
              />
            </div>
            <div className="field">
              <label className="label">结束（秒）</label>
              <input
                className="input mono"
                type="number"
                step={0.1}
                min={0}
                max={clipDur / 1000}
                value={(end / 1000).toFixed(1)}
                onChange={(e) => setEnd(Math.min(clipDur, Number(e.target.value) * 1000))}
              />
            </div>
          </div>
          <div className="field">
            <label className="label">选择素材</label>
            <AssetList
              disabled={false}
              onPick={(id, name, url) => setPicked({ id, name, url })}
              onUploaded={() => toast.push('素材已上传', 'success')}
            />
            {picked && (
              <div className="row tiny" style={{ gap: 6, marginTop: 6, color: 'var(--success)' }}>
                <IconCheck size={11} /> 已选择：{picked.name}
              </div>
            )}
          </div>
          <label className="row sm" style={{ gap: 8, cursor: 'pointer' }}>
            <input type="checkbox" checked={true} disabled />
            保留原视频说话音频（当前阶段始终保留）
          </label>
        </div>
        <div className="modal-foot">
          <div className="spacer" />
          <button className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" disabled={busy || !picked} onClick={submit}>
            {busy ? <IconLoader size={14} /> : null} 应用替换
          </button>
        </div>
      </div>
    </div>
  )
}
