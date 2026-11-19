import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { Project } from '../types'

/** 轮询项目状态，直到 stopWhen 返回 true */
export function usePollProject(projectId: string | undefined, intervalMs = 1200, stopWhen?: (p: Project) => boolean) {
  const [project, setProject] = useState<Project | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const stopRef = useRef(stopWhen)
  stopRef.current = stopWhen

  const reload = useCallback(async () => {
    if (!projectId) return
    try {
      const p = await api.project(projectId)
      setProject(p)
      setError(null)
      return p
    } catch (e: any) {
      setError(e.message)
      return null
    } finally {
      setLoading(false)
    }
  }, [projectId])

  // 任务结束后停止；手动重试并 reload 到进行中状态时重新启动轮询。
  const stopped = project?.id === projectId && project !== null && Boolean(stopWhen?.(project))

  useEffect(() => {
    if (!projectId || stopped) return
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    let failStreak = 0
    const tick = async () => {
      const p = await reload()
      if (!alive) return
      if (p) {
        failStreak = 0
        if (stopRef.current?.(p)) return
      } else {
        // 连续失败（如后端挂了、项目被删）不要无限重试，避免持续打请求
        failStreak++
        if (failStreak >= 3) return
      }
      timer = setTimeout(tick, failStreak ? intervalMs * 2 : intervalMs)
    }
    void tick()
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [reload, intervalMs, projectId, stopped])

  return { project, setProject, error, loading, reload }
}

export function projectProgress(p: Project): number {
  const tasks = p.analysis.tasks
  if (!tasks.length) return 0
  const sum = tasks.reduce((n, t) => n + (t.status === 'completed' ? 100 : t.progress), 0)
  return Math.round(sum / tasks.length)
}
