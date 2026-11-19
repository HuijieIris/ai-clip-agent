import type { Packaging } from '../../../packages/shared/packaging'
import type { EditPlan, ChannelId } from '../../../packages/shared/editing'
import type { HighlightDetails, HighlightRun, Translation } from '../../../packages/shared/highlights'
export type StageStatus = 'pending' | 'processing' | 'completed' | 'failed'
export type AnalysisStage =
  | 'queued' | 'audio_extract' | 'transcribe' | 'scene_index' | 'highlight' | 'completed' | 'failed' | 'cancelled'

export interface AnalysisTask {
  source?: 'volc' | 'whisper'
  fallbackFrom?: 'volc'
  id: 'audio_extract' | 'transcribe' | 'scene_index' | 'highlight'
  label: string
  status: StageStatus
  progress: number
  message?: string
}
export interface TranscriptSegment {
  id: string
  start: number
  end: number
  text: string
  keywords?: string[]
}
export interface Highlight {
  details?: HighlightDetails
  id: string
  title: string
  reason: string
  start: number
  end: number
  score: number
  transcript: string
  tags: string[]
  status: 'draft' | 'edited'
}
export interface EditOperation {
  id: string
  type: 'trim' | 'subtitle' | 'replace' | 'cover' | 'frame'
  at: number
  payload: any
  summary: string
  createdAt: number
  reversible: boolean
  applied: boolean
}
export interface SubtitleCue {
  sourceCueId?: string
  id: string
  start: number
  end: number
  text: string
}
export interface AssetReplacement {
  sourceReplacementId?: string
  assetIn?: number
  id: string
  start: number
  end: number
  assetId: string
  assetName: string
  assetUrl: string
  keepAudio: boolean
}
export interface ClipCover {
  source: 'frame' | 'upload'
  frameTime: number
  imageUrl: string | null
  title: string
  titleStyle: { fontSize: number; color: string; weight: number; x: number; y: number; align: 'left' | 'center' | 'right' }
  firstScreenDuration: number
}
export interface Clip {
  highlightId?:string
  subtitleMode?:import('../../../packages/shared/packaging').SubtitleMode
  packaging?:Packaging
  editPlan?: EditPlan
  id: string
  projectId: string
  title: string
  start: number
  end: number
  score: number
  reason: string
  transcript: string
  tags: string[]
  selected: boolean
  status: 'draft' | 'edited' | 'framed'
  subtitles: SubtitleCue[]
  replacements: AssetReplacement[]
  operations: EditOperation[]
  transform?: { scale: number; offsetX: number; offsetY: number }
  cover?: ClipCover
  updatedAt: number
}
export interface Project {
  autoFrameRun?:{jobId:string;status:"preparing"|"rendering"|"completed"|"failed";message:string;clipIds:string[];previewJobIds:string[]}
  activeClipIds?:string[]
  brand?: {channelId:ChannelId|null;template:FrameTemplate;confirmedAt:number|null;revision:number}
  highlightRun?: HighlightRun
  highlightHistory?: HighlightRun[]
  translations?: Translation[]
  transcriptMissingRanges?: { start: number; end: number }[]
  recommendationSettings?: { profile?: string; searchMode?: 'off' | 'auto' | 'required'; recordedAt?: string }

  id: string
  title: string
  fileName: string
  duration: number
  width: number
  height: number
  sizeBytes: number
  templateId: string | null
  targetRatio: string
  minDuration: number
  maxDuration: number
  desiredCount: number
  analysis: {
    stage: AnalysisStage
    tasks: AnalysisTask[]
    startedAt?: number
    finishedAt?: number
    error?: string
  }
  transcript: TranscriptSegment[]
  highlights: Highlight[]
  clips: Clip[]
  createdAt: number
  updatedAt: number
}
export interface FrameTemplate {
  channelIds?: ChannelId[]
  version?: number
  id: string
  name: string
  canvas: { width: number; height: number }
  coverFrameAssetId: string | null
  coverFrameUrl: string | null
  bodyFrameAssetId: string | null
  bodyFrameUrl: string | null
  videoViewport: { x: number; y: number; width: number; height: number }
  subtitleSafeArea: { x: number; y: number; width: number; height: number }
  coverTitleSafeArea: { x: number; y: number; width: number; height: number }
  defaultTransform: { scale: number; offsetX: number; offsetY: number }
  createdAt: number
  updatedAt: number
  lastUsedAt?: number
}
export interface ExportJob {
  runToken?:string
  purpose?: "preview"|"export"
  editRevision?: number
  renderSnapshot?: {project:Pick<Project,'id'|'fileName'|'duration'>;clip:Clip;template:FrameTemplate}
  id: string
  projectId: string
  clipId: string
  clipTitle: string
  status: 'queued' | 'rendering' | 'completed' | 'failed'
  progress: number
  message?: string
  fileUrl?: string
  coverUrl?: string
  ratio: string
  resolution: string
  format: 'mp4'
  withSubtitles: boolean
  exportCover: boolean
  createdAt: number
  updatedAt: number
}
export interface LibraryAsset {
  id: string
  name: string
  url: string
  kind: 'image' | 'video'
  createdAt: number
}
export interface UploadedVideo {
  fileName: string
  originalName: string
  url: string
  thumbnail: string | null
  duration: number
  width: number
  height: number
  sizeBytes: number
  hasAudio: boolean
}
export interface Health {
  ok: boolean
  ffmpeg: boolean
  aiMode: 'cloud' | 'unavailable' | 'local'
  asrMode?: 'volc' | 'whisper' | 'unavailable'
  asrLocalFallback?: boolean
  asr?: { appId: string; endpoint: string; resourceId: string; chunkSec: number } | null
  localWhisper?: { bin: string; model: string; lang: string; chunkSec: number; concurrency: number; hotwordPrompt: string } | null
}
