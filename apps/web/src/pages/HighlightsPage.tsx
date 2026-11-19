import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api } from '../api'
import { AppShell } from '../layout/AppShell'
import { Alert, Badge, Checkbox, Empty } from '../ui/kit'
import {
  IconPlay, IconPause, IconSparkle, IconRefresh, IconLoader, IconChevronRight, IconClock, IconPlus, IconFilm, IconTarget,
} from '../ui/icons'
import { ms, msLong } from '../lib/time'
import { usePollProject } from '../lib/usePollProject'
import { useToast } from '../ui/toast'
import type { Highlight } from '../types'

export function HighlightsPage() {
  const { id } = useParams()
  const nav = useNavigate()
  const toast = useToast()
  const { project, setProject, reload, loading } = usePollProject(id, 60_000, () => true)
  const videoRef = useRef<HTMLVideoElement>(null)
  const [playingId, setPlayingId] = useState<string | null>(null)
  const [current, setCurrent] = useState(0)
  const transcriptRef=useRef<HTMLDivElement>(null)
  const transcriptRows=useRef(new Map<string,HTMLDivElement>())
  const initializedBatch=useRef('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [manual, setManual] = useState<{ start: number; end: number } | null>(null)
  const [manualMode, setManualMode] = useState(false)
  const [busy, setBusy] = useState(false)
  const [profile, setProfile] = useState('')
  const [searchMode, setSearchMode] = useState<'off'|'auto'|'required'>('auto')
  const [recordedAt, setRecordedAt] = useState('')
  const translations = useMemo(() => new Map((project?.translations || []).map(t => [t.segmentId,t])), [project?.translations])
  useEffect(() => {
    if (project) {
      setProfile(project.recommendationSettings?.profile || '')
      setSearchMode(project.recommendationSettings?.searchMode || 'auto')
      setRecordedAt(project.recommendationSettings?.recordedAt?.slice(0,10) || '')
    }
  }, [project?.id])

  // 每个推荐批次只初始化一次，用户取消全选/手动增删后不重新覆盖。
  const selectionBatch=project?`${project.id}:${project.highlightRun?.id??'legacy'}`:''
  useEffect(()=>{
    if(!project||project.id!==id||!project.highlights.length||initializedBatch.current===selectionBatch)return
    initializedBatch.current=selectionBatch
    setSelected(new Set([...project.highlights].sort((a,b)=>b.score-a.score).slice(0,4).map(h=>h.id)))
  },[selectionBatch,project?.highlights.length,id])
  const activeTranscriptId=project?.transcript.find(s=>current>=s.start&&current<s.end)?.id
  useEffect(()=>{
    const container=transcriptRef.current,row=activeTranscriptId?transcriptRows.current.get(activeTranscriptId):undefined
    if(!container||!row)return
    const box=container.getBoundingClientRect(),item=row.getBoundingClientRect()
    const top=container.scrollTop+item.top-box.top-container.clientHeight*.35
    container.scrollTo({top:Math.max(0,top),behavior:Math.abs(top-container.scrollTop)>container.clientHeight?'auto':'smooth'})
  },[activeTranscriptId])

  const highlights = project?.highlights ?? []
  const source = project ? `/files/uploads/${project.fileName}` : ''

  useEffect(() => {
    const v = videoRef.current
    if (!v || !project) return
    const onTime = () => setCurrent(v.currentTime * 1000)
    const events=['timeupdate','seeking','seeked','loadedmetadata']
    events.forEach(event=>v.addEventListener(event,onTime))
    onTime()
    return ()=>events.forEach(event=>v.removeEventListener(event,onTime))
  }, [project?.id])

  const playClip = (h: Highlight) => {
    const v = videoRef.current
    if (!v) return
    v.currentTime = h.start / 1000
    void v.play()
    setPlayingId(h.id)
  }

  useEffect(() => {
    const v = videoRef.current
    if (!v || !playingId) return
    const h = highlights.find((x) => x.id === playingId)
    if (!h) return
    const onTime = () => {
      if (v.currentTime * 1000 >= h.end) {
        v.pause()
        setPlayingId(null)
      }
    }
    v.addEventListener('timeupdate', onTime)
    return () => v.removeEventListener('timeupdate', onTime)
  }, [playingId, highlights])

  const toggle = (hid: string) => {
    setSelected((prev) => {
      const n = new Set(prev)
      if (n.has(hid)) n.delete(hid)
      else n.add(hid)
      return n
    })
  }

  const seek = (t: number) => {
    const v = videoRef.current
    if (!v) return
    v.currentTime = t / 1000
    setCurrent(t)
  }

  const regen = async () => {
    if (!project) return
    setBusy(true)
    try {
      await api.recommend(project.id, {profile,searchMode,recordedAt})
      toast.push('正在复用原文重新推荐，不重复识别…', 'info')
      nav(`/projects/${project.id}/analyzing`)
    } catch (e: any) {
      toast.push(e.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const addManual = async () => {
    if (!project || !manual) return
    if (manual.end - manual.start < 1000) {
      toast.push('片段至少 1 秒', 'error')
      return
    }
    setBusy(true)
    try {
      const h = await api.addManualHighlight(project.id, manual.start, manual.end)
      await reload()
      setSelected((prev) => new Set([...prev, h.id]))
      setManual(null)
      setManualMode(false)
      toast.push('已添加手动片段', 'success')
    } catch (e: any) {
      toast.push(e.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const proceed = async () => {
    if (!project) return
    if (selected.size === 0) {
      toast.push('请至少选择 1 条片段', 'error')
      return
    }
    setBusy(true)
    try {
      const r = await api.createClips(project.id, [...selected])
      const first = r.clips.find((c) => selected.has(c.id)) ?? r.clips[0]
      if (!first) {
        toast.push('未能创建片段，请重试', 'error')
        setBusy(false)
        return
      }
      nav(`/projects/${project.id}/editor/${first.id}`)
    } catch (e: any) {
      toast.push(e.message, 'error')
      setBusy(false)
    }
  }

  const totalDur = useMemo(
    () => highlights.filter((h) => selected.has(h.id)).reduce((n, h) => n + (h.end - h.start), 0),
    [highlights, selected]
  )

  if (loading && !project) {
    return (
      <AppShell>
        <div className="row" style={{ justifyContent: 'center', padding: 80 }}><IconLoader size={22} /></div>
      </AppShell>
    )
  }
  if (!project) {
    return (
      <AppShell>
        <Empty title="项目不存在" desc="可能已被删除" action={<button className="btn btn-secondary" onClick={() => nav('/projects')}>返回项目列表</button>} />
      </AppShell>
    )
  }

  const selectedHighlights = selected

  return (
    <AppShell
      crumbs={<><span>创作流程</span><span style={{ opacity: 0.5 }}>/</span><b>高光筛选</b></>}
      topbarRight={
        <>
          <span className="tiny muted">项目：{project.title}</span>
          <button className="btn btn-ghost btn-sm" onClick={() => setManualMode((v) => !v)}>
            <IconPlus size={13} /> 手动框选
          </button>
        </>
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: '60% 40%', gap: 18, height: 'calc(100vh - 130px)' }}>
        {/* 左：播放器 + 逐字稿 */}
        <div className="panel">
          <div style={{ background: '#05070a', position: 'relative', aspectRatio: '16/9', maxHeight: 330, flexShrink: 0 }}>
            <video
              ref={videoRef}
              src={source}
              controls
              style={{ width: '100%', height: '100%', objectFit: 'contain', background: '#05070a' }}
            />
          </div>

          {/* 高光进度条 */}
          <div style={{ padding: '14px 16px 10px', borderBottom: '1px solid var(--border-soft)' }}>
            <div
              style={{ height: 26, background: 'var(--bg-app)', borderRadius: 6, position: 'relative', overflow: 'hidden', cursor: 'pointer' }}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect()
                seek(((e.clientX - r.left) / r.width) * project.duration)
              }}
            >
              {highlights.map((h) => (
                <div
                  key={h.id}
                  title={h.title}
                  onClick={(e) => {
                    e.stopPropagation()
                    playClip(h)
                    toggle(h.id)
                  }}
                  style={{
                    position: 'absolute',
                    left: `${(h.start / project.duration) * 100}%`,
                    width: `${((h.end - h.start) / project.duration) * 100}%`,
                    top: 0,
                    bottom: 0,
                    background: selected.has(h.id) ? 'rgba(201,255,77,.45)' : 'rgba(169,178,192,.22)',
                    borderLeft: '1px solid rgba(11,14,19,.8)',
                    transition: 'background 150ms',
                  }}
                />
              ))}
              <div
                style={{
                  position: 'absolute', left: `${(current / project.duration) * 100}%`, top: 0, bottom: 0,
                  width: 1.5, background: '#fff', pointerEvents: 'none',
                }}
              />
            </div>
            <div className="row tiny muted mono" style={{ marginTop: 6, justifyContent: 'space-between' }}>
              <span>{msLong(0)}</span>
              <span>当前 {ms(current)} / 共 {msLong(project.duration)}</span>
              <span>{msLong(project.duration)}</span>
            </div>
          </div>

          {/* 手动框选 */}
          {manualMode && (
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-soft)', background: 'rgba(201,255,77,.03)' }}>
              <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
                <div style={{ width: 110 }}>
                  <div className="tiny muted" style={{ marginBottom: 3 }}>开始 (秒)</div>
                  <input
                    className="input input-sm mono" type="number"
                    value={manual ? (manual.start / 1000).toFixed(1) : ((current / 1000) | 0)}
                    onChange={(e) => {
                      const s = Number(e.target.value) * 1000
                      setManual({ start: s, end: manual?.end ?? Math.min(project.duration, s + 30000) })
                    }}
                  />
                </div>
                <div style={{ width: 110 }}>
                  <div className="tiny muted" style={{ marginBottom: 3 }}>结束 (秒)</div>
                  <input
                    className="input input-sm mono" type="number"
                    value={manual ? (manual.end / 1000).toFixed(1) : (((current + 30000) / 1000) | 0)}
                    onChange={(e) => {
                      const en = Number(e.target.value) * 1000
                      setManual({ start: manual?.start ?? current, end: en })
                    }}
                  />
                </div>
                <button className="btn btn-sm btn-secondary" onClick={() => setManual({ start: current, end: Math.min(project.duration, current + 30000) })}>
                  从当前位置取 30s
                </button>
                <div className="spacer" />
                <button className="btn btn-sm btn-primary" disabled={!manual || busy} onClick={addManual}>
                  添加为片段
                </button>
              </div>
              <div className="tiny muted" style={{ marginTop: 6 }}>
                手动片段不带 AI 评分，但同样可进入剪辑与导出流程。
              </div>
            </div>
          )}

          {/* 逐字稿 */}
          <div className="panel-head" style={{ borderTop: '1px solid var(--border-soft)' }}>
            <span className="card-title" style={{ fontSize: 14 }}>逐字稿</span>
            <div className="spacer" />
            <span className="tiny muted">点击句子跳转到原视频</span>
          </div>
          <div ref={transcriptRef} className="panel-body" style={{ padding: 8,overflowY:'auto',minHeight:0 }}>
            {project.transcript.length === 0 ? (
              <Empty title="没有逐字稿" desc="该视频无音轨或转写失败，可用手动框选添加片段" />
            ) : (
              project.transcript.map((s) => {
                const inHl = highlights.some((h) => s.start >= h.start && s.end <= h.end && selected.has(h.id))
                return (
                  <div key={s.id} ref={node=>{if(node)transcriptRows.current.set(s.id,node);else transcriptRows.current.delete(s.id)}} aria-current={s.id===activeTranscriptId?'true':undefined} className={`tx-line ${inHl ? 'on' : ''} ${s.id===activeTranscriptId?'tx-playing':''}`} onClick={() => seek(s.start)}>
                    <span className="tx-time mono">{ms(s.start)}</span>
                    <div style={{flex:1}}>
                      <div className="secondary">{s.text}</div>
                      {translations.get(s.id) && translations.get(s.id)?.status !== 'original_zh' && (
                        <div style={{marginTop:5,color:'var(--text-primary)'}}>
                          中文：{translations.get(s.id)?.textZh}
                          <div className="tiny muted">{translations.get(s.id)?.status === 'reviewed' ? '已对照原文复核，尚需结合原声判断' : '译文待核对，请点击回听原声'}{translations.get(s.id)?.issues.length ? ` · ${translations.get(s.id)?.issues.join('；')}` : ''}</div>
                        </div>
                      )}
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </div>

        {/* 右：高光卡 */}
        <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div className="row" style={{ marginBottom: 10 }}>
            <h2 className="h2" style={{ fontSize: 17 }}>高光片段</h2>
            <Badge kind="accent">{highlights.length}</Badge>
            <div className="spacer" />
            <button className="btn btn-sm btn-ghost" onClick={regen} disabled={busy}>
              <IconRefresh size={13} /> 重新生成
            </button>
          </div>

          <details className="card" style={{padding:12,marginBottom:10}}>
            <summary style={{cursor:'pointer'}}>推荐偏好与联网搜索</summary>
            <div style={{display:'grid',gap:8,marginTop:10}}>
              <label className="tiny">频道 / 观众 / 目标（可选）
                <textarea className="input" value={profile} maxLength={1000} onChange={e=>setProfile(e.target.value)} placeholder="例如：面向创业者，关注具体经营案例" />
              </label>
              <label className="tiny">联网搜索
                <select className="input" value={searchMode} onChange={e=>setSearchMode(e.target.value as typeof searchMode)}>
                  <option value="auto">按需：术语、背景、事实及新闻</option><option value="off">关闭</option><option value="required">必须尝试检索</option>
                </select>
              </label>
              <label className="tiny">素材录制日期（可选）<input className="input" type="date" value={recordedAt} onChange={e=>setRecordedAt(e.target.value)} /></label>
              <button className="btn btn-secondary btn-sm" disabled={busy || !project.transcript.length} onClick={regen}>应用设置并重新推荐</button>
            </div>
          </details>
          {project.highlightRun?.warnings.length ? <div className="tiny" role="status" style={{marginBottom:10,color:'var(--warning)'}}>{project.highlightRun.warnings.join('；')}{project.highlightRun.status === 'failed' ? '；下方如有旧候选，属于上次结果。' : ''}</div> : null}
          <div className="scroll-y" style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 10, paddingRight: 2 }}>
            {highlights.length === 0 && (
              <Empty
                icon={<IconSparkle size={20} />}
                title="没有高光候选"
                desc="AI 未找到符合时长要求的片段，可放宽最短/最长时长，或手动框选一段。"
                action={<button className="btn btn-secondary btn-sm" onClick={() => nav(`/projects/${project.id}/analyzing`)}>查看分析详情</button>}
              />
            )}
            {highlights.map((h) => {
              const on = selected.has(h.id)
              return (
                <div
                  key={h.id}
                  className={`hl-card ${on ? 'on' : ''} ${playingId === h.id ? 'playing' : ''}`}
                  onClick={() => playClip(h)}
                >
                  <Checkbox on={on} label="选择片段" onClick={(e)=>{e.stopPropagation();toggle(h.id)}} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="row" style={{ gap: 7 }}>
                      <span style={{ fontWeight: 600, fontSize: 13.5, flex: 1, minWidth: 0, overflow: 'hidden', display:'-webkit-box',WebkitBoxOrient:'vertical',WebkitLineClamp:2,whiteSpace:'normal',lineHeight:1.5,overflowWrap:'anywhere' }}>
                        {h.title}
                      </span>
                      {h.score > 0 ? (
                        <Badge kind={h.score >= 85 ? 'accent' : undefined}>{h.score} 分</Badge>
                      ) : (
                        <Badge>手动</Badge>
                      )}
                    </div>
                    <div className="row tiny muted mono" style={{ gap: 10, marginTop: 3 }}>
                      <span className="row" style={{ gap: 4 }}><IconClock size={11} />{ms(h.start)} → {ms(h.end)}</span>
                      <span>·</span>
                      <span>时长 {((h.end - h.start) / 1000).toFixed(1)}s</span>
                    </div>
                    <div
                      style={{
                        marginTop: 7, fontSize: 12.5, lineHeight: 1.6, color: 'var(--text-secondary)',
                        background: 'var(--bg-app)', padding: '7px 9px', borderRadius: 8, borderLeft: '2px solid rgba(201,255,77,.5)',
                      }}
                    >
                      <b style={{ color: 'var(--accent)', fontSize: 11 }}>推荐理由 · </b>
                      {h.reason}
                    </div>
                    {h.details && (
                      <details onClick={e=>e.stopPropagation()} style={{marginTop:8,fontSize:12,lineHeight:1.7}}>
                        <summary style={{cursor:'pointer'}}>评分依据 · 双语 · 语气与来源</summary>
                        <div style={{marginTop:6}}>{h.details.transcriptZh}</div>
                        <div className="tiny muted" style={{marginTop:5}}>原声：{h.details.audio.status === 'reviewed' ? '模型已复听（非准确性保证）' : h.details.audio.status === 'error' ? '分析失败' : h.details.audio.status === 'skipped' ? '需按当前范围人工回听' : '未配置音频理解模型'}；转写核对：{h.details.audio.transcriptCheck === 'consistent' ? '模型认为一致' : h.details.audio.transcriptCheck === 'needs_review' ? '有疑点需人工确认' : '未知'}</div>
                        {h.details.audio.issues.map((issue,i)=><div key={i} className="tiny muted">{issue}</div>)}
                        {h.details.audio.observations.map((o,i)=><div key={i}>音频线索：{o.label}（{ms(o.start)}–{ms(o.end)}，{o.certainty === 'clear' ? '清晰' : '不确定'}）：{o.evidence}</div>)}
                        {h.details.signals.map((signal,i)=><div key={i} className="tiny muted">文字推断：{signal.ruleId} · “{signal.quote}”</div>)}
                        {Object.entries(h.details.dimensions).map(([key,d])=><div key={key} className="tiny">{({semantic_completeness:'语义完整性',information_value:'信息价值',hook_potential:'开头吸引力',audience_fit:'受众匹配',evidence_fidelity:'原文忠实度'} as Record<string,string>)[key]} {d.score}/5：{d.reason}</div>)}
                        {h.details.reviewFlags.includes('translation_needs_review') ? <div style={{color:'var(--warning)'}}>译文存在疑点，请对照原文回听。</div> : null}
                        <div className="tiny muted">新闻关联：{({matched:'有相关报道线索',unmatched:'未匹配',insufficient_evidence:'证据不足',unavailable:'搜索未配置',error:'搜索失败',skipped:'未触发或已关闭'} as Record<string,string>)[h.details.trend.status]} · {h.details.trend.reason}</div>
                        {h.details.trend.sourceIds.map(sourceId=>{
                          const batch=[project.highlightRun,...(project.highlightHistory||[])].find(r=>r?.id===h.details?.analysisRunId)
                          const source=batch?.searches.flatMap(r=>r.sources).find(s=>s.id===sourceId)
                          return source ? <div key={sourceId}><a href={source.url} target="_blank" rel="noreferrer">{source.title}</a><span className="tiny muted">（搜索摘录，未核实全文）</span></div> : null
                        })}
                      </details>
                    )}
                    {h.tags.length > 0 && (
                      <div className="row wrap" style={{ gap: 4, marginTop: 7 }}>
                        {h.tags.map((t) => (
                          <span key={t} className="badge" style={{ height: 18, fontSize: 10.5 }}>{t}</span>
                        ))}
                      </div>
                    )}
                    <div className="row" style={{ gap: 6, marginTop: 9 }}>
                      <button
                        className="btn btn-sm btn-ghost"
                        onClick={(e) => {
                          e.stopPropagation()
                          playingId === h.id ? (videoRef.current?.pause(), setPlayingId(null)) : playClip(h)
                        }}
                      >
                        {playingId === h.id ? <IconPause size={11} /> : <IconPlay size={11} />}
                        {playingId === h.id ? '暂停' : '预览'}
                      </button>
                      <button
                        className="btn btn-sm btn-ghost"
                        onClick={async (e) => {
                          e.stopPropagation()
                          await api.deleteHighlight(project.id, h.id)
                          setSelected((prev) => {
                            const n = new Set(prev)
                            n.delete(h.id)
                            return n
                          })
                          await reload()
                        }}
                      >
                        移除
                      </button>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>

          {/* 底部吸附栏 */}
          <div className="card" style={{ padding: 14, marginTop: 10, flexShrink: 0, background: 'var(--bg-elevated)' }}>
            <div className="row" style={{ marginBottom: 10 }}>
              <span className="sm">
                已选 <b style={{ color: 'var(--accent)' }}>{selected.size}</b> / {highlights.length} 条
              </span>
              <span className="tiny muted mono" style={{ marginLeft: 10 }}>总时长 {(totalDur / 1000).toFixed(1)}s</span>
              <div className="spacer" />
              <button
                className="btn btn-sm btn-ghost"
                onClick={() => setSelected(selected.size === highlights.length ? new Set() : new Set(highlights.map((h) => h.id)))}
              >
                {selected.size === highlights.length ? '取消全选' : '全选'}
              </button>
            </div>
            <button className="btn btn-primary btn-block" disabled={selected.size === 0 || busy} onClick={proceed}>
              {busy ? <IconLoader size={15} /> : <IconFilm size={15} />}
              编辑选中 {selected.size} 条
              <IconChevronRight size={15} />
            </button>
          </div>
        </div>
      </div>
    </AppShell>
  )
}
