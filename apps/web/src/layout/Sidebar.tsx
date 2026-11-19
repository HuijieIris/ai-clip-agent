import { NavLink, useLocation } from 'react-router-dom'
import { Fragment, useEffect, useState } from 'react'
import {
  IconGrid, IconFolder, IconLayers, IconFrame, IconScissors, IconCheck, IconChevronLeft, IconChevronRight,
} from '../ui/icons'
import { api } from '../api'
import type { Health } from '../types'

const NAV = [
  { to: '/', label: '工作台', icon: IconGrid, end: true },
  { to: '/projects', label: '我的项目', icon: IconFolder, end: false },
  { to: '/assets', label: '素材库', icon: IconLayers, end: false },
  { to: '/templates', label: '我的模板', icon: IconFrame, end: false },
]

const STEPS = ['导入', '分析', '筛选', '剪辑', '成片', '导出']
const COLLAPSE_KEY = 'ai-clip.sidebar.collapsed'

export function stageIndexFromPath(path: string): number {
  if (path.includes('/analyzing')) return 1
  if (path.includes('/highlights')) return 2
  if (path.includes('/editor')) return 3
  if (path.includes('/review')) return 4
  if (path.includes('/export')) return 5
  if (path.includes('/projects/new')) return 0
  return -1
}

export function Sidebar() {
  const loc = useLocation()
  const idx = stageIndexFromPath(loc.pathname)
  const [health, setHealth] = useState<Health | null>(null)
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === '1'
    } catch {
      return false
    }
  })

  useEffect(() => {
    api.health().then(setHealth).catch(() => setHealth(null))
  }, [])

  // 记住用户的折叠偏好，刷新后保持
  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0')
    } catch {
      // localStorage 不可用（隐私模式）时忽略
    }
  }, [collapsed])

  // 折叠状态下按 Cmd/Ctrl + B 也能切换
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        setCollapsed((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 配置探测状态；真实调用结果显示在分析任务中。
  const asr = health?.asrMode ?? 'unavailable'
  const asrLabel = !health ? '连接中…'
    : asr === 'volc' ? '火山 ASR 已配置'
    : asr === 'whisper' ? '本地 Whisper 已配置' : '语音识别不可用'
  const asrColor = !health ? 'var(--text-muted)' : asr === 'unavailable' ? 'var(--warning)' : 'var(--success)'
  const asrTitle = asr === 'volc'
    ? `火山录音文件识别；本地兜底${health?.asrLocalFallback ? '已开启' : '未开启'}。实际鉴权及识别结果以分析任务为准`
    : asr === 'whisper'
      ? `本地 Whisper（${health?.localWhisper?.model ?? '?'}）；执行文件已找到，模型及推理能力以实际转写为准`
      : '请配置火山凭据，或配置本地 Whisper 并选择 whisper / 开启 ASR_LOCAL_FALLBACK。不会生成占位字幕'

  // 高光推荐状态
  const aiLabel = !health ? '连接中…' : health.aiMode === 'cloud' ? '模型推荐高光' : '高光模型未配置'
  const aiColor = !health ? 'var(--text-muted)' : health.aiMode === 'cloud' ? 'var(--success)' : 'var(--warning)'
  const aiTitle =
    health?.aiMode === 'cloud' ? '高光由大模型读取逐字稿产出' : '请配置独立的高光文本模型凭据；不会用规则分数冒充模型推荐'

  return (
    <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
      <div className="brand">
        <div className="brand-mark">
          <IconScissors size={17} strokeWidth={2.2} />
        </div>
        {!collapsed && (
          <div>
            <div className="brand-name">AI 智能切片</div>
            <div className="brand-sub">长视频高光工作台</div>
          </div>
        )}
        <button
          className="sidebar-toggle"
          onClick={() => setCollapsed((v) => !v)}
          title={collapsed ? '展开侧边栏（⌘B）' : '收起侧边栏（⌘B）'}
          aria-label={collapsed ? '展开侧边栏' : '收起侧边栏'}
        >
          {collapsed ? <IconChevronRight size={14} /> : <IconChevronLeft size={14} />}
        </button>
      </div>

      <nav className="nav-list">
        {NAV.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.end}
            title={collapsed ? n.label : undefined}
            className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
          >
            <span className="nav-icon">
              <n.icon size={17} />
            </span>
            {!collapsed && n.label}
          </NavLink>
        ))}
      </nav>

      {idx >= 0 && (
        <div className="steps">
          {collapsed ? (
            // 收起时只显示当前进度，避免挤压
            <div className="steps-collapsed mono" title={`创作流程 ${idx + 1}/${STEPS.length} · ${STEPS[idx]}`}>
              {idx + 1}/{STEPS.length}
            </div>
          ) : (
            <>
              <div className="steps-head">
                <span>创作流程</span>
                <span className="mono">{Math.min(idx + 1, STEPS.length)}/{STEPS.length}</span>
              </div>
              <div className="step-list">
                {STEPS.map((s, i) => (
                  <Fragment key={s}>
                    <div className={`step-row ${i < idx ? 'done' : i === idx ? 'current' : ''}`}>
                      <span className="step-dot">{i < idx ? <IconCheck size={9} /> : i + 1}</span>
                      {s}
                    </div>
                    {i < STEPS.length - 1 && <div className={`step-line ${i < idx ? 'done' : ''}`} />}
                  </Fragment>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      <div className="sidebar-status">
        <div className="row" style={{ gap: 6 }} title={asrTitle}>
          <span
            className="dot-pulse"
            style={{ background: asrColor }}
          />
          {!collapsed && asrLabel}
        </div>
        <div className="row" style={{ gap: 6, marginTop: 2 }} title={aiTitle}>
          <span className="dot-pulse" style={{ background: aiColor }} />
          {!collapsed && aiLabel}
        </div>
        <div className="row" style={{ gap: 6, marginTop: 2 }} title={health?.ffmpeg ? 'ffmpeg 可用' : 'ffmpeg 不可用'}>
          <span className="dot-pulse" style={{ background: health?.ffmpeg ? 'var(--success)' : 'var(--error)' }} />
          {!collapsed && (health?.ffmpeg ? 'ffmpeg 可用' : 'ffmpeg 不可用')}
        </div>
      </div>
    </aside>
  )
}
