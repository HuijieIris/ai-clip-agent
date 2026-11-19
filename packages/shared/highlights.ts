export type SearchPurpose = 'news' | 'translation' | 'background' | 'fact_check'
export type SearchStatus = 'ok' | 'empty' | 'error' | 'unavailable' | 'skipped'
export interface SearchSource {
  id: string; title: string; url: string; publisher: string
  publishedAt: string | null; retrievedAt: string; excerpt: string
  evidenceLevel: 'snippet'; originGroupId: string
}
export interface SearchResult {
  purpose: SearchPurpose; query: string; status: SearchStatus; sources: SearchSource[]
  windowDays: number | null; error?: string
}
export interface Translation {
  segmentId: string; textZh: string
  status: 'reviewed' | 'needs_review' | 'original_zh'
  issues: string[]
}
export type DimensionKey = 'semantic_completeness' | 'information_value' | 'hook_potential' | 'audience_fit' | 'evidence_fidelity'
export interface Dimension { score: number; reason: string; segmentIds: string[] }
export type Dimensions = Record<DimensionKey, Dimension>
export interface ContentSignal { ruleId: string; segmentIds: string[]; basis: 'text'; quote: string }
export interface AudioReview {
  status: 'reviewed' | 'unavailable' | 'error' | 'skipped'
  observations: { label: string; start: number; end: number; evidence: string; certainty: 'clear' | 'uncertain' }[]
  transcriptCheck: 'consistent' | 'needs_review' | 'unknown'
  issues: string[]
}
export interface HighlightDetails {
  analysisRunId: string; transcriptVersion: string
  source: 'llm'; startSegmentId: string; endSegmentId: string
  transcriptZh: string; dimensions: Dimensions; signals: ContentSignal[]
  evidence: { segmentId: string; quote: string }[]; reviewFlags: string[]
  trend: { status: 'matched' | 'unmatched' | 'insufficient_evidence' | 'unavailable' | 'error' | 'skipped'; relation: 'same_event' | 'topic_related' | 'none'; sourceIds: string[]; reason: string; verificationStatus: 'partial' | 'unverified' }
  audio: AudioReview
}
export interface HighlightRun {
  id: string; transcriptVersion: string; promptVersion: string; translationVersion?: string; rulesVersion: string
  provider: string; model: string; status: 'processing' | 'completed' | 'failed' | 'cancelled'
  createdAt: number; finishedAt?: number; requestedCount: number; actualCount: number
  warnings: string[]; rejectionReasons: string[]; searches: SearchResult[]
  reviewed?: {candidateId:string;decision:'accept'|'reject'|'needs_boundary_repair';startSegmentId:string;endSegmentId:string;title:string;reason:string;tags:string[];dimensions:Dimensions;evidence:{segmentId:string;quote:string}[];duplicateOf:string|null;reviewFlags:string[];rejectionReason:string|null}[]
  translations: Translation[]
  recall?: {settingsVersion:string;completedWindows:number;candidates:{id:string;startSegmentId:string;endSegmentId:string;coreSegmentIds:string[];title:string;reason:string;signals:ContentSignal[]}[];topics:{summary:string;segmentIds:string[]}[]}
  calls: { stage: string; model: string; elapsedMs: number; inputTokens: number | null; outputTokens: number | null; status: 'processing' | 'ok' | 'error'; validationError?:string }[]
}
export interface RecommendationOptions {
  minDuration: number; maxDuration: number; count: number; durationMs?: number
  profile?: string; searchMode?: 'off' | 'auto' | 'required'; recordedAt?: string
  missingRanges?: { start: number; end: number }[]
  resumeRun?: HighlightRun
  audioPath?: string; signal?: AbortSignal
  onProgress?: (message: string) => void
}
