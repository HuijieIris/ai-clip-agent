import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api } from '../api'
import { AppShell } from '../layout/AppShell'
import { Alert, Badge, Empty, Progress } from '../ui/kit'
import { IconFilm, IconClock, IconFrame, IconLoader, IconChevronRight, IconScissors, IconSparkle, IconDownload } from '../ui/icons'
import { msLong, timeAgo } from '../lib/time'
import { projectProgress, usePollProject } from '../lib/usePollProject'
import type { FrameTemplate } from '../types'

export function ProjectDetailPage() {
  const { id } = useParams()
  const nav = useNavigate()
  const { project, error, loading } = usePollProject(id, 5000, (p) => p.analysis.stage === 'completed')
  const [tpl, setTpl] = useState<FrameTemplate | null>(null)

  useEffect(() => {
    if (project?.templateId) api.template(project.templateId).then(setTpl).catch(() => setTpl(null))
  }, [project?.templateId])

  if (loading && !project) {
    return <AppShell><div className="row" style={{ justifyContent: 'center', padding: 80 }}><IconLoader size={22} /></div></AppShell>
  }
  if (error || !project) {
    return (
      <AppShell>
        <Alert kind="error" title="加载失败">{error ?? '项目不存在'}</Alert>
      </AppShell>
    )
  }

  const steps = [
    { label: 'AI 内容分析', desc: `4 个后台任务 · 逐字稿 ${project.transcript.length} 句`, path: `analyzing`, done: project.analysis.stage === 'completed' },
    { label: '高光筛选', desc: `${project.highlights.length} 条候选`, path: 'highlights', done: project.highlights.length > 0 },
    { label: '二次剪辑', desc: `${project.clips.length} 个片段`, path: project.clips[0] ? `editor/${project.clips[0].id}` : 'highlights', done: project.clips.some((c) => c.status !== 'draft') },
    { label: '成片确认', desc: `套用「${tpl?.name ?? '模板'}」`, path: 'review', done: project.clips.some((c) => c.status === 'framed') },
    { label: '批量导出', desc: 'MP4 批量渲染', path: 'export', done: false },
  ]

  return (
    <AppShell
      crumbs={<><span>我的项目</span><span style={{ opacity: 0.5 }}>/</span><b>{project.title}</b></>}
      topbarRight={<button className="btn btn-ghost btn-sm" onClick={() => nav('/projects')}>返回列表</button>}
    >
      <div style={{ maxWidth: 980, margin: '0 auto' }}>
        <div className="row" style={{ gap: 12, marginBottom: 4 }}>
          <h1 className="h1" style={{ fontSize: 26 }}>{project.title}</h1>
          <Badge kind={project.analysis.stage === 'completed' ? 'success' : 'accent'}>
            {project.analysis.stage === 'completed' ? '分析完成' : '分析中'}
          </Badge>
        </div>
        <div className="row tiny muted mono" style={{ gap: 16, marginBottom: 22 }}>
          <span className="row" style={{ gap: 4 }}><IconClock size={12} />{msLong(project.duration)}</span>
          <span>{project.width}×{project.height}</span>
          <span className="row" style={{ gap: 4 }}><IconFrame size={12} />{tpl?.name ?? '—'}</span>
          <span>更新于 {timeAgo(project.updatedAt)}</span>
        </div>

        {project.analysis.stage !== 'completed' && (
          <div className="card card-pad" style={{ marginBottom: 16 }}>
            <div className="row" style={{ marginBottom: 8 }}>
              <span className="sm">分析进度</span>
              <div className="spacer" />
              <span className="tiny mono secondary">{projectProgress(project)}%</span>
            </div>
            <Progress value={projectProgress(project)} />
          </div>
        )}

        <div className="col" style={{ gap: 10 }}>
          {steps.map((s, i) => (
            <div
              key={s.label}
              className="card card-hover"
              style={{ padding: 16, display: 'flex', alignItems: 'center', gap: 14, cursor: 'pointer' }}
              onClick={() => nav(`/projects/${project.id}/${s.path}`)}
            >
              <div
                style={{
                  width: 32, height: 32, borderRadius: 9, display: 'grid', placeItems: 'center',
                  background: s.done ? 'rgba(85,214,156,.12)' : 'var(--bg-elevated)',
                  color: s.done ? 'var(--success)' : 'var(--text-muted)', flexShrink: 0, fontSize: 12, fontWeight: 700,
                }}
              >
                {i + 1}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 13.5 }}>{s.label}</div>
                <div className="tiny muted">{s.desc}</div>
              </div>
              <IconChevronRight size={15} className="muted" />
            </div>
          ))}
        </div>

        {project.highlights.length > 0 && (
          <>
            <h2 className="h2" style={{ fontSize: 16, margin: '24px 0 10px' }}>高光候选</h2>
            <div className="col" style={{ gap: 8 }}>
              {project.highlights.slice(0, 5).map((h) => (
                <div key={h.id} className="card card-pad" style={{ padding: 14 }}>
                  <div className="row" style={{ gap: 8 }}>
                    <b style={{ fontSize: 13.5 }}>{h.title}</b>
                    {h.score > 0 && <Badge kind="accent">{h.score} 分</Badge>}
                    <div className="spacer" />
                    <span className="tiny muted mono">{msLong(h.start)} → {msLong(h.end)}</span>
                  </div>
                  <div className="tiny secondary" style={{ marginTop: 4 }}>{h.reason}</div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </AppShell>
  )
}
