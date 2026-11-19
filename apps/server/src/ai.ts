import type { TranscriptSegment } from './types'
import { modelReady } from './highlights/model'
export { transcribe, asrMode } from './asr-service'
export { recommendHighlights as findHighlights } from './highlights/workflow'
export function aiMode(): 'cloud' | 'unavailable' { return modelReady() ? 'cloud' : 'unavailable' }
export function transcriptText(segs: TranscriptSegment[], start: number, end: number): string {
  return segs.filter(s => s.end > start && s.start < end).map(s => s.text).join(' ')
}
