import type { ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { Sidebar, stageIndexFromPath } from './Sidebar'

const STAGE_LABEL = ['导入长视频', 'AI 内容分析', '高光筛选', '二次剪辑', '成片确认', '批量导出']

export function AppShell({ children, topbarRight, crumbs, fullWidth }: { children: ReactNode; topbarRight?: ReactNode; crumbs?: ReactNode; fullWidth?: boolean }) {
  const loc = useLocation()
  const idx = stageIndexFromPath(loc.pathname)
  return (
    <div className={`app-shell${fullWidth ? ' app-shell-full' : ''}`}>
      {!fullWidth && <Sidebar />}
      <div className="main">
        <div className="topbar">
          <div className="crumbs">
            {crumbs ?? (
              <>
                <span>{idx >= 0 ? '创作流程' : '工作区'}</span>
                {idx >= 0 && (
                  <>
                    <span style={{ opacity: 0.5 }}>/</span>
                    <b>{STAGE_LABEL[idx]}</b>
                  </>
                )}
              </>
            )}
          </div>
          <div className="topbar-right">{topbarRight}</div>
        </div>
        <div className="content">{children}</div>
      </div>
    </div>
  )
}
