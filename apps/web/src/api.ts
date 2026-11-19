export interface PackagingJob {id:string;projectId:string;clipIds:string[];status:'queued'|'processing'|'completed'|'failed';message:string;completed:number;total:number}
import type {Packaging} from '../../../packages/shared/packaging'
import type {
  Project, FrameTemplate, Clip, ExportJob, LibraryAsset, UploadedVideo, Health, Highlight,
} from './types'

class ApiError extends Error {
  status: number
  payload: any
  constructor(message: string, status: number, payload?: any) {
    super(message)
    this.status = status
    this.payload = payload
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  const text = await res.text()
  let data: any = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  if (!res.ok) {
    throw new ApiError(data?.error ?? `请求失败 (${res.status})`, res.status, data)
  }
  return data as T
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

export const api = {
  health: () => request<Health>('/api/health'),

  // 上传
  uploadVideo: (file: File) => {
    const fd = new FormData()
    fd.append('file', file)
    return request<UploadedVideo>('/api/upload/video', { method: 'POST', body: fd })
  },
  uploadFromUrl: (url: string) => request<UploadedVideo>('/api/upload/from-url', json({ url })),
  uploadAsset: (file: File) => {
    const fd = new FormData()
    fd.append('file', file)
    return request<LibraryAsset>('/api/upload/asset', { method: 'POST', body: fd })
  },
  assets: () => request<LibraryAsset[]>('/api/assets'),
  estimateCount: (duration: number, minDuration: number, maxDuration: number) =>
    request<{ count: number; reason: string }>('/api/estimate-count', json({ duration, minDuration, maxDuration })),

  // 模板
  templates: () => request<FrameTemplate[]>('/api/templates'),
  template: (id: string) => request<FrameTemplate>(`/api/templates/${id}`),
  createTemplate: (body: Partial<FrameTemplate>) => request<FrameTemplate>('/api/templates', json(body)),
  updateTemplate: (id: string, body: Partial<FrameTemplate>) =>
    request<FrameTemplate>(`/api/templates/${id}`, { ...json(body), method: 'PATCH' }),
  deleteTemplate: (id: string) => request<{ ok: true }>(`/api/templates/${id}`, { method: 'DELETE' }),

  // 项目
  projects: () => request<Project[]>('/api/projects'),
  project: (id: string) => request<Project>(`/api/projects/${id}`),
  bindBrand: (id:string,body:Record<string,unknown>) => request<Project>(`/api/projects/${id}/brand`, {...json(body),method:'PATCH'}),
  createProject: (body: Record<string, unknown>) => request<Project>('/api/projects', json(body)),

  analyze: (id: string) => request<{ ok: true }>(`/api/projects/${id}/analyze`, { method: 'POST' }),
  recommend: (id: string, settings: {profile?:string;searchMode?:'off'|'auto'|'required';recordedAt?:string} = {}) => request<{ok:true}>(`/api/projects/${id}/recommend`, json(settings)),
  cancelAnalyze: (id: string) => request<{ ok: true }>(`/api/projects/${id}/analyze/cancel`, { method: 'POST' }),

  // 高光
  saveHighlights: (id: string, highlights: Highlight[]) =>
    request<Project>(`/api/projects/${id}/highlights`, json({ highlights })),
  addManualHighlight: (id: string, start: number, end: number) =>
    request<Highlight>(`/api/projects/${id}/highlights/manual`, json({ start, end })),
  deleteHighlight: (id: string, hid: string) =>
    request<{ ok: true }>(`/api/projects/${id}/highlights/${hid}`, { method: 'DELETE' }),
  createClips: (id: string, highlightIds: string[]) =>
    request<{ clips: Clip[] }>(`/api/projects/${id}/clips`, json({ highlightIds })),

  // 剪辑
  patchClip: (pid: string, cid: string, patch: Partial<Clip>) =>
    request<Clip>(`/api/projects/${pid}/clips/${cid}`, { ...json(patch), method: 'PATCH' }),
  clipOp: (pid: string, cid: string, body: Record<string, unknown>) =>
    request<{ clip: Clip }>(`/api/projects/${pid}/clips/${cid}/ops`, json(body)),
  nlEdit: (pid: string, cid: string, instruction: string,expectedRevision?:number) =>
    request<{ ok: boolean; clip: Clip; summary: string; error?: string; supported?: string[] }>(
      `/api/projects/${pid}/clips/${cid}/nl`,
      json({ instruction,expectedRevision })
    ),
  patchFrame: (pid: string, cid: string, body: Record<string, unknown>) =>
    request<{ clip: Clip; affected: number }>(`/api/projects/${pid}/clips/${cid}/frame`, { ...json(body), method: 'PATCH' }),
  coverFrame: (pid: string, cid: string, absoluteTimeMs: number) =>
    request<{ cover: any; clip:Clip; url: string }>(`/api/projects/${pid}/clips/${cid}/cover/frame`, json({ absoluteTimeMs })),

  batchPackagingStyle:(pid:string,cid:string,body:Record<string,unknown>)=>request<Project>(`/api/projects/${pid}/clips/${cid}/packaging-style`,json(body)),
  resumeAutoFrame:(pid:string)=>request<NonNullable<Project['autoFrameRun']>>(`/api/projects/${pid}/autoframe/resume`,{method:'POST'}),
  autoFrame:(pid:string)=>request<NonNullable<Project['autoFrameRun']>>(`/api/projects/${pid}/autoframe`,{method:'POST'}),
  prepareSubtitles:(pid:string,cid:string)=>request<PackagingJob>(`/api/projects/${pid}/clips/${cid}/subtitles/prepare`,{method:'POST'}),
  packagingDraft:(pid:string,cid:string)=>request<Packaging>(`/api/projects/${pid}/clips/${cid}/packaging`),
  copyReviewClip: (pid: string, cid: string, body: Record<string, unknown>) =>
    request<{ project: Project; clipId: string }>(`/api/projects/${pid}/clips/${cid}/review-copy`, json(body)),
  applyReviewBgm: (pid: string, body: Record<string, unknown>) =>
    request<Project>(`/api/projects/${pid}/apply-review-bgm`, json(body)),
  savePresentation:(pid:string,cid:string,body:Record<string,unknown>)=>request<{clip:Clip}>(`/api/projects/${pid}/clips/${cid}/presentation`,json(body)),
  generatePackaging:(pid:string,clipIds:string[],cueId?:string)=>request<PackagingJob>(`/api/projects/${pid}/packaging`,json({clipIds,cueId})),
  packagingJob:(id:string)=>request<PackagingJob>(`/api/packaging/${id}`),
  textFonts:()=>request<{id:'sans'|'serif'|'shuhei';name:string}[]>('/api/packaging/fonts'),
  textPreview:(pid:string,cid:string,packaging:Packaging,time:number)=>request<{cover:string|null;body:string|null;subtitle:string|null}>(`/api/projects/${pid}/clips/${cid}/text-preview`,json({packaging,time})),
  // 导出
  exports: (pid: string) => request<ExportJob[]>(`/api/projects/${pid}/exports`),
  exportClips: (pid: string, body: { clipIds: string[]; ratio: string; resolution: string; withSubtitles: boolean; exportCover: boolean; preview?:boolean }) =>
    request<{ jobs: ExportJob[] }>(`/api/projects/${pid}/export`, json(body)),
  retryExport: (id: string) => request<ExportJob>(`/api/exports/${id}/retry`, { method: 'POST' }),
  downloadAll: (ids: string[]) =>
    request<{ url: string }>(`/api/exports/download-all?ids=${ids.join(',')}`),

  workbench: () =>
    request<{ projects: number; clips: number; exports: number; templates: number; recent: Project[] }>('/api/workbench'),
}

export { ApiError }
