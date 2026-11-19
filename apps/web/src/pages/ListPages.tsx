import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../api'
import { AppShell } from '../layout/AppShell'
import { Badge, Empty, Progress } from '../ui/kit'
import { IconPlus, IconFilm, IconFolder, IconFrame, IconLayers, IconChevronRight, IconLoader, IconSparkle, IconScissors } from '../ui/icons'
import { msLong, timeAgo } from '../lib/time'
import type { Project } from '../types'
import { projectProgress } from '../lib/usePollProject'
import { FrameTemplateDialog } from './FrameTemplateDialog'

const STAGE_TEXT: Record<string, { label: string; kind?: 'accent' | 'success' | 'warning' | 'error'; path: string }> = {
  queued: { label: '等待分析', kind: 'warning', path: 'analyzing' },
  audio_extract: { label: '分析中', kind: 'accent', path: 'analyzing' },
  transcribe: { label: '分析中', kind: 'accent', path: 'analyzing' },
  scene_index: { label: '分析中', kind: 'accent', path: 'analyzing' },
  highlight: { label: '分析中', kind: 'accent', path: 'analyzing' },
  completed: { label: '分析完成', kind: 'success', path: 'highlights' },
  failed: { label: '分析失败', kind: 'error', path: 'analyzing' },
  cancelled: { label: '已取消', kind: 'warning', path: 'analyzing' },
}

export function DashboardPage() {
  const nav = useNavigate()
  const [data, setData] = useState<{ projects: number; clips: number; exports: number; templates: number; recent: Project[] } | null>(null)
  const [tplCount, setTplCount] = useState(0)

  useEffect(() => {
    api.workbench().then(setData).catch(() => setData(null))
  }, [])

  const stats = [
    { label: '进行中项目', value: data?.projects ?? '—', icon: IconFilm },
    { label: '已切片段', value: data?.clips ?? '—', icon: IconScissors },
    { label: '已完成导出', value: data?.exports ?? '—', icon: IconSparkle },
    { label: '包框模板', value: data?.templates ?? '—', icon: IconFrame },
  ]

  return (
    <AppShell topbarRight={<span className="tiny muted">深色创作工作台</span>}>
      <div style={{ maxWidth: 1180, margin: '0 auto' }}>
        <div style={{ marginBottom: 24 }}>
          <h1 className="h1" style={{ marginBottom: 6 }}>开始一次智能切片</h1>
          <p className="secondary sm">导入长视频 → AI 找高光 → 人工精修 → 套用固定包框 → 批量导出 MP4。</p>
        </div>

        {/* 主入口 */}
        <div
          className="card"
          style={{
            padding: 28, display: 'flex', alignItems: 'center', gap: 24, marginBottom: 20,
            background: 'linear-gradient(120deg, rgba(201,255,77,.07), rgba(23,28,37,1) 55%)',
            borderColor: 'rgba(201,255,77,.18)',
          }}
        >
          <div style={{ flex: 1 }}>
            <div className="row" style={{ gap: 8, marginBottom: 8 }}>
              <Badge kind="accent">主流程</Badge>
              <span className="tiny muted">6 个步骤 · 到批量导出结束</span>
            </div>
            <h2 className="h2" style={{ marginBottom: 6 }}>上传一个长视频，10 分钟拿到一批短视频</h2>
            <p className="secondary sm" style={{ maxWidth: 560 }}>
              包框只需上传一次，之后所有视频都能复用。AI 推荐的高光片段支持人工裁剪、改字幕、换画面，成片由云端 ffmpeg 真实渲染。
            </p>
          </div>
          <button className="btn btn-primary btn-lg" onClick={() => nav('/projects/new')}>
            <IconPlus size={16} /> 新建切片项目
          </button>
        </div>

        {/* 统计 */}
        <div className="grid-4" style={{ marginBottom: 24 }}>
          {stats.map((s) => (
            <div key={s.label} className="card card-pad">
              <div className="row" style={{ gap: 8, marginBottom: 8 }}>
                <span className="secondary"><s.icon size={15} /></span>
                <span className="tiny muted">{s.label}</span>
              </div>
              <div className="mono" style={{ fontSize: 26, fontWeight: 700, letterSpacing: '-.02em' }}>{s.value}</div>
            </div>
          ))}
        </div>

        {/* 最近项目 */}
        <div className="row" style={{ marginBottom: 12 }}>
          <h2 className="h2" style={{ fontSize: 17 }}>最近项目</h2>
          <div className="spacer" />
          <Link className="btn btn-ghost btn-sm" to="/projects">全部项目 <IconChevronRight size={13} /></Link>
        </div>

        {!data ? (
          <div className="row" style={{ justifyContent: 'center', padding: 40 }}><IconLoader size={20} /></div>
        ) : data.recent.length === 0 ? (
          <div className="card">
            <Empty
              icon={<IconFolder size={20} />}
              title="还没有项目"
              desc="先创建一个切片项目。需要先准备一个视频包框模板（封面 + 正文各一张）。"
              action={<button className="btn btn-primary btn-sm" onClick={() => nav('/projects/new')}>新建项目</button>}
            />
          </div>
        ) : (
          <div className="col" style={{ gap: 8 }}>
            {data.recent.map((p) => {
              const st = STAGE_TEXT[p.analysis.stage] ?? STAGE_TEXT.queued
              const pct = projectProgress(p)
              return (
                <div
                  key={p.id}
                  className="card card-hover"
                  style={{ padding: 14, display: 'flex', alignItems: 'center', gap: 14, cursor: 'pointer' }}
                  onClick={() => nav(`/projects/${p.id}`)}
                >
                  <div style={{ width: 36, height: 36, borderRadius: 9, background: 'rgba(201,255,77,.09)', display: 'grid', placeItems: 'center', color: 'var(--accent)' }}>
                    <IconFilm size={16} />
                  </div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="row" style={{ gap: 8 }}>
                      <b style={{ fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.title}</b>
                      <Badge kind={st.kind}>{st.label}</Badge>
                    </div>
                    <div className="tiny muted mono" style={{ marginTop: 2 }}>
                      {msLong(p.duration)} · {p.clips.length} 个片段 · {timeAgo(p.updatedAt)}
                    </div>
                  </div>
                  {p.analysis.stage !== 'completed' && (
                    <div style={{ width: 80 }}>
                      <Progress value={pct} thin />
                    </div>
                  )}
                  <IconChevronRight size={15} className="muted" />
                </div>
              )
            })}
          </div>
        )}
      </div>
    </AppShell>
  )
}

export function ProjectsPage() {
  const nav = useNavigate()
  const [list, setList] = useState<Project[] | null>(null)

  useEffect(() => {
    api.projects().then(setList).catch(() => setList([]))
  }, [])

  const go = (p: Project) => {
    if (p.analysis.stage === 'completed') nav(`/projects/${p.id}/highlights`)
    else if (p.analysis.stage === 'failed' || p.analysis.stage === 'cancelled') nav(`/projects/${p.id}/analyzing`)
    else nav(`/projects/${p.id}/analyzing`)
  }

  return (
    <AppShell topbarRight={<button className="btn btn-primary btn-sm" onClick={() => nav('/projects/new')}><IconPlus size={13} /> 新建项目</button>}>
      <div style={{ maxWidth: 1180, margin: '0 auto' }}>
        <h1 className="h1" style={{ marginBottom: 6 }}>我的项目</h1>
        <p className="secondary sm" style={{ marginBottom: 22 }}>每个项目对应一个长视频与一次切片任务。</p>

        {!list ? (
          <div className="row" style={{ justifyContent: 'center', padding: 60 }}><IconLoader size={20} /></div>
        ) : list.length === 0 ? (
          <div className="card">
            <Empty icon={<IconFolder size={20} />} title="没有项目" desc="创建第一个切片项目开始工作。" action={<button className="btn btn-primary btn-sm" onClick={() => nav('/projects/new')}>新建项目</button>} />
          </div>
        ) : (
          <div className="col" style={{ gap: 8 }}>
            {list.map((p) => {
              const st = STAGE_TEXT[p.analysis.stage] ?? STAGE_TEXT.queued
              return (
                <div key={p.id} className="card card-hover" style={{ padding: 16, display: 'flex', gap: 14, alignItems: 'center' }}>
                  <div style={{ width: 44, height: 44, borderRadius: 10, background: 'var(--bg-elevated)', display: 'grid', placeItems: 'center', color: 'var(--text-secondary)' }}>
                    <IconFilm size={18} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="row" style={{ gap: 8 }}>
                      <b style={{ fontSize: 14 }}>{p.title}</b>
                      <Badge kind={st.kind}>{st.label}</Badge>
                    </div>
                    <div className="tiny muted mono" style={{ marginTop: 3 }}>
                      {msLong(p.duration)} · {p.width}×{p.height} · {p.clips.length} 片段 · {p.highlights.length} 候选 · 更新于 {timeAgo(p.updatedAt)}
                    </div>
                  </div>
                  <div className="row" style={{ gap: 6 }}>
                    <button className="btn btn-sm btn-secondary" onClick={() => go(p)}>打开</button>
                    <button
                      className="btn btn-sm btn-ghost"
                      onClick={async () => {
                        if (!confirm(`删除项目「${p.title}」？此操作不可撤销。`)) return
                        const res = await fetch(`/api/projects/${p.id}`, { method: 'DELETE' })
                        if (res.ok) setList((l) => l?.filter((x) => x.id !== p.id) ?? null)
                      }}
                    >
                      删除
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </AppShell>
  )
}

export function AssetsPage() {
  const [list, setList] = useState<{ id: string; name: string; url: string; kind: string; createdAt: number }[]>([])
  const [uploading, setUploading] = useState(false)

  const load = () => api.assets().then(setList).catch(() => {})
  useEffect(() => {
    void load()
  }, [])

  return (
    <AppShell topbarRight={
      <label className="btn btn-primary btn-sm">
        {uploading ? <IconLoader size={13} /> : <IconPlus size={13} />} 上传素材
        <input type="file" accept="image/*,video/*" hidden onChange={async (e) => {
          const f = e.target.files?.[0]
          e.target.value = ''
          if (!f) return
          setUploading(true)
          try {
            await api.uploadAsset(f)
            await load()
          } catch (err: any) {
            alert(err.message)
          } finally {
            setUploading(false)
          }
        }} />
      </label>
    }>
      <div style={{ maxWidth: 1180, margin: '0 auto' }}>
        <h1 className="h1" style={{ marginBottom: 6 }}>素材库</h1>
        <p className="secondary sm" style={{ marginBottom: 22 }}>用于替换片段画面的本地素材。</p>
        {list.length === 0 ? (
          <div className="card"><Empty icon={<IconLayers size={20} />} title="还没有素材" desc="在剪辑页或这里上传图片/视频，用于替换指定片段画面。" /></div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 12 }}>
            {list.map((a) => (
              <div key={a.id} className="card card-hover" style={{ padding: 8 }}>
                <div style={{ aspectRatio: '16/9', background: '#0b0e13', borderRadius: 8, overflow: 'hidden', display: 'grid', placeItems: 'center' }}>
                  {a.kind === 'image' ? <img src={a.url} alt={a.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <IconFilm size={18} className="muted" />}
                </div>
                <div className="tiny" style={{ marginTop: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</div>
                <div className="tiny muted" style={{ fontSize: 10 }}>{a.kind === 'image' ? '图片' : '视频'} · {timeAgo(a.createdAt)}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </AppShell>
  )
}

export function TemplatesPage() {
  const [list, setList] = useState<Awaited<ReturnType<typeof api.templates>> | null>(null)
  const [open, setOpen] = useState(false)

  const load = () => api.templates().then(setList).catch(() => setList([]))
  useEffect(() => {
    void load()
  }, [])

  return (
    <AppShell topbarRight={<button className="btn btn-primary btn-sm" onClick={() => setOpen(true)}><IconPlus size={13} /> 新建模板</button>}>
      <div style={{ maxWidth: 1180, margin: '0 auto' }}>
        <h1 className="h1" style={{ marginBottom: 6 }}>我的模板</h1>
        <p className="secondary sm" style={{ marginBottom: 22 }}>包框上传一次，所有视频项目可重复使用；封面与正文包框独立保存。</p>

        {!list ? (
          <div className="row" style={{ justifyContent: 'center', padding: 60 }}><IconLoader size={20} /></div>
        ) : list.length === 0 ? (
          <div className="card"><Empty icon={<IconFrame size={20} />} title="还没有包框模板" desc="创建模板需要分别上传封面包框和正文包框。" action={<button className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>创建模板</button>} /></div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 14 }}>
            {list.map((t) => (
              <div key={t.id} className="card card-pad">
                <div className="tpl-thumbs">
                  <div className="tpl-thumb"><img src={t.coverFrameUrl ?? ''} alt="" /><span className="tpl-thumb-label">封面</span></div>
                  <div className="tpl-thumb"><img src={t.bodyFrameUrl ?? ''} alt="" /><span className="tpl-thumb-label">正文</span></div>
                </div>
                <div className="row" style={{ gap: 8 }}>
                  <b style={{ fontSize: 13.5, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</b>
                  <button className="btn btn-sm btn-ghost" onClick={async () => {
                    if (!confirm(`删除模板「${t.name}」？`)) return
                    await api.deleteTemplate(t.id)
                    await load()
                  }}>删除</button>
                </div>
                <div className="tiny muted mono">{t.canvas.width}×{t.canvas.height} · {timeAgo(t.updatedAt)}</div>
              </div>
            ))}
          </div>
        )}
      </div>
      <FrameTemplateDialog
        open={open}
        onClose={() => setOpen(false)}
        onCreated={() => {
          setOpen(false)
          void load()
        }}
      />
    </AppShell>
  )
}
