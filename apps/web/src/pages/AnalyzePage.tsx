import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api } from '../api'
import { AppShell } from '../layout/AppShell'
import { Alert, Badge, Progress } from '../ui/kit'
import { IconCheck, IconLoader, IconRefresh, IconX, IconChevronRight, IconFilm, IconClock, IconFrame, IconSparkle } from '../ui/icons'
import { msLong } from '../lib/time'
import { projectProgress, usePollProject } from '../lib/usePollProject'
import { useToast } from '../ui/toast'

export function AnalyzePage() {
  const { id } = useParams()
  const nav = useNavigate()
  const toast = useToast()
  const [autoJump, setAutoJump] = useState(true)
  const { project, error, loading, reload } = usePollProject(id, 1100, (p) =>
    p.analysis.stage === 'completed' || p.analysis.stage === 'failed' || p.analysis.stage === 'cancelled'
  )
  const [tplName, setTplName] = useState('')

  useEffect(() => {
    if (project?.templateId) {
      api.template(project.templateId).then((t) => setTplName(t.name)).catch(() => setTplName(''))
    }
  }, [project?.templateId])

  const done = project?.analysis.stage === 'completed'
  const failed = project?.analysis.stage === 'failed' || project?.analysis.stage === 'cancelled'

  useEffect(() => {
    if (done && autoJump) {
      const t = setTimeout(() => nav(`/projects/${id}/highlights`), 900)
      return () => clearTimeout(t)
    }
  }, [done, autoJump, id, nav])

  if (loading && !project) {
    return (
      <AppShell>
        <div className="row" style={{ justifyContent: 'center', padding: 80 }}>
          <IconLoader size={22} />
        </div>
      </AppShell>
    )
  }
  if (error || !project) {
    return (
      <AppShell>
        <Alert kind="error" title="无法加载项目">{error ?? '项目不存在'}</Alert>
        <button className="btn btn-secondary" style={{ marginTop: 12 }} onClick={() => nav('/projects')}>返回项目列表</button>
      </AppShell>
    )
  }

  const pct = projectProgress(project)

  return (
    <AppShell
      crumbs={
        <>
          <span>创作流程</span>
          <span style={{ opacity: 0.5 }}>/</span>
          <b>AI 内容分析</b>
        </>
      }
      topbarRight={
        <button className="btn btn-ghost btn-sm" onClick={() => nav(`/projects/${project.id}`)}>
          项目信息
        </button>
      }
    >
      <div style={{ maxWidth: 1180, margin: '0 auto' }}>
        <div className="row" style={{ gap: 10, marginBottom: 4 }}>
          <h1 className="h1">AI 正在分析内容</h1>
          <Badge kind="accent">第 2 步</Badge>
        </div>
        <p className="secondary sm" style={{ marginBottom: 20 }}>
          原文转写 → 中文翻译与复核 → 分段召回 → 全局复评与切点校验。可复用逐字稿重新推荐。
        </p>

        {/* 视频信息条 */}
        <div className="card" style={{ padding: 14, display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16, flexWrap: 'wrap' }}>
          <div
            style={{
              width: 40, height: 40, borderRadius: 10, background: 'rgba(201,255,77,.1)',
              display: 'grid', placeItems: 'center', color: 'var(--accent)',
            }}
          >
            <IconFilm size={18} />
          </div>
          <div>
            <div style={{ fontWeight: 600, fontSize: 13.5 }}>{project.title}</div>
            <div className="tiny muted mono">
              {project.fileName.split('_').pop()}
            </div>
          </div>
          <div className="row" style={{ gap: 16, marginLeft: 8 }}>
            <div className="row tiny muted" style={{ gap: 5 }}>
              <IconClock size={12} /> {msLong(project.duration)}
            </div>
            <div className="row tiny muted" style={{ gap: 5 }}>
              <IconFrame size={12} /> {tplName || '模板'}
            </div>
            <div className="tiny muted mono">{project.width}×{project.height}</div>
          </div>
          <div className="spacer" />
          <div className="row" style={{ gap: 10 }}>
            <div style={{ width: 120 }}>
              <Progress value={pct} thin />
            </div>
            <span className="tiny mono secondary" style={{ width: 34 }}>{pct}%</span>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 380px', gap: 16, alignItems: 'start' }}>
          {/* 任务卡 */}
          <div className="col" style={{ gap: 10 }}>
            {project.analysis.tasks.map((t, i) => {
              const isCur = t.status === 'processing'
              return (
                <div
                  key={t.id}
                  className="card"
                  style={{
                    padding: 16,
                    display: 'flex',
                    gap: 14,
                    alignItems: 'center',
                    borderColor: isCur ? 'rgba(201,255,77,.35)' : undefined,
                    background: isCur ? 'rgba(201,255,77,.035)' : undefined,
                  }}
                >
                  <div
                    style={{
                      width: 34, height: 34, borderRadius: 9, display: 'grid', placeItems: 'center', flexShrink: 0,
                      background:
                        t.status === 'completed' ? 'rgba(85,214,156,.13)' : t.status === 'failed' ? 'rgba(255,119,125,.13)' : 'var(--bg-elevated)',
                      color: t.status === 'completed' ? 'var(--success)' : t.status === 'failed' ? 'var(--error)' : 'var(--text-muted)',
                    }}
                  >
                    {t.status === 'completed' ? <IconCheck size={16} /> : t.status === 'failed' ? <IconX size={16} /> : t.status === 'processing' ? <IconLoader size={16} /> : <span className="mono tiny">{i + 1}</span>}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="row" style={{ gap: 8 }}>
                      <span style={{ fontWeight: 600, fontSize: 13.5 }}>{t.label}</span>
                      {t.status === 'processing' && <Badge kind="accent">进行中</Badge>}
                      {t.status === 'completed' && <Badge kind="success">完成</Badge>}
                      {t.status === 'failed' && <Badge kind="error">失败</Badge>}
                      {t.status === 'pending' && <Badge>等待中</Badge>}
                    </div>
                    {t.message && <div className="tiny muted" style={{ marginTop: 2 }}>{t.message}</div>}
                    {t.status === 'processing' && (
                      <div style={{ marginTop: 7 }}>
                        <Progress value={t.progress} thin />
                      </div>
                    )}
                  </div>
                </div>
              )
            })}

            {failed && (
              <Alert kind="error" title={project.analysis.stage === 'cancelled' ? '分析已取消' : '分析未完成'}>
                {project.analysis.error ?? '部分任务失败'}
                <div className="row" style={{ gap: 8, marginTop: 10 }}>
                  <button
                    className="btn btn-sm btn-secondary"
                    onClick={async () => {
                      try {
                        if (project.transcript.length && project.analysis.tasks.find(t=>t.id==='transcribe')?.status==='completed') await api.recommend(project.id)
                        else await api.analyze(project.id)
                        toast.push('已重新开始分析', 'success')
                        await reload()
                      } catch (e: any) {
                        toast.push(e.message, 'error')
                      }
                    }}
                  >
                    <IconRefresh size={13} /> {project.transcript.length && project.analysis.tasks.find(t=>t.id==='transcribe')?.status==='completed' ? '复用逐字稿重试高光' : '重试全部分析'}
                  </button>
                  <button className="btn btn-sm btn-ghost" onClick={() => nav('/projects')}>返回项目列表</button>
                </div>
              </Alert>
            )}

            {done && (
              <div className="card" style={{ padding: 16, borderColor: 'rgba(85,214,156,.3)', background: 'rgba(85,214,156,.04)' }}>
                <div className="row" style={{ gap: 8 }}>
                  <IconSparkle size={16} style={{ color: 'var(--success)' }} />
                  <b style={{ fontSize: 13.5 }}>分析完成，生成 {project.highlights.length} 条高光候选</b>
                </div>
                <label className="row sm muted" style={{ gap: 7, marginTop: 8, cursor: 'pointer' }}>
                  <input type="checkbox" checked={autoJump} onChange={(e) => setAutoJump(e.target.checked)} />
                  完成后自动进入高光筛选
                </label>
                <button className="btn btn-primary btn-block" style={{ marginTop: 12 }} onClick={() => nav(`/projects/${project.id}/highlights`)}>
                  查看高光片段 <IconChevronRight size={15} />
                </button>
              </div>
            )}

            {!done && !failed && (
              <button
                className="btn btn-ghost btn-sm"
                style={{ alignSelf: 'flex-start' }}
                onClick={async () => {
                  await api.cancelAnalyze(project.id)
                  await reload()
                  toast.push('已请求取消')
                }}
              >
                取消分析
              </button>
            )}
          </div>

          {/* 逐字稿预览 */}
          <div className="panel" style={{ maxHeight: 520 }}>
            <div className="panel-head">
              <span className="card-title">逐字稿</span>
              <div className="spacer" />
              <span className="tiny muted mono">{project.transcript.length} 句</span>
            </div>
            <div className="panel-body" style={{ padding: 8 }}>
              {project.transcript.length === 0 ? (
                <div className="empty" style={{ padding: 30 }}>
                  <IconLoader size={18} className="muted" />
                  <div className="tiny">转写中，完成后逐句带时间戳展示</div>
                </div>
              ) : (
                project.transcript.map((s) => (
                  <div key={s.id} className="tx-line">
                    <span className="tx-time mono">{new Date(s.start).toISOString().slice(14, 19)}</span>
                    <span className="secondary" style={{ flex: 1 }}>{s.text}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  )
}
