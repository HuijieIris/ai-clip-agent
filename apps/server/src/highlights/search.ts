import '../env'
import { createHash } from 'node:crypto'
import type { SearchPurpose, SearchResult, SearchSource } from '../../../../packages/shared/highlights'
import { combineSignal } from './model'

export interface SearchRequest { purpose: SearchPurpose; query: string; windowDays?: number }
export type SearchTool = (request: SearchRequest, signal?: AbortSignal) => Promise<SearchResult>
const cache = new Map<string, { expires: number; value: SearchResult }>()
export function publicUrl(raw: unknown): string | null {
  try {
    const u = new URL(String(raw))
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || !host.includes('.') || host.endsWith('.local') || host.endsWith('.localhost') || host.endsWith('.internal') || host.includes(':')) return null
    // 不访问这些 URL；仅允许作为用户可点击的外部证据链接。
    if (/^(?:0|10|127)\.|^169\.254\.|^192\.168\.|^172\.(?:1[6-9]|2\d|3[01])\.|^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return null
    u.hash = ''
    return u.toString()
  } catch { return null }
}
export const webSearch: SearchTool = async (request, signal) => {
  const purpose = request.purpose
  const query = request.query.trim().slice(0, 300)
  const windowDays = purpose === 'news' ? (request.windowDays === 30 ? 30 : 7) : null
  const base: SearchResult = { purpose, query, status: 'unavailable', sources: [], windowDays }
  if (!process.env.TAVILY_API_KEY) return base
  const cacheKey = JSON.stringify([purpose, query, windowDays])
  const prior = cache.get(cacheKey)
  if (prior && prior.expires > Date.now()) return structuredClone(prior.value)
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST', signal: combineSignal(signal, 10_000),
      headers: { Authorization: `Bearer ${process.env.TAVILY_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, topic: purpose === 'news' ? 'news' : 'general', ...(windowDays ? { time_range: windowDays === 7 ? 'week' : 'month' } : {}), max_results: 5, include_answer: false, include_raw_content: false }),
    })
    if (!res.ok) return { ...base, status: 'error', error: `联网搜索 HTTP ${res.status}` }
    const body = await res.json() as any
    if (!Array.isArray(body.results)) throw new Error('搜索响应缺少 results')
    const sources: SearchSource[] = body.results.slice(0, 5).flatMap((item: any) => {
      const url = publicUrl(item.url)
      if (!url || typeof item.title !== 'string' || typeof item.content !== 'string') return []
      const date = typeof item.published_date === 'string' ? Date.parse(item.published_date) : NaN
      return [{ id: 'src_' + createHash('sha256').update(url).digest('hex').slice(0, 16), title: item.title.slice(0, 300), url, publisher: new URL(url).hostname,
        publishedAt: Number.isFinite(date) ? new Date(date).toISOString() : null, retrievedAt: new Date().toISOString(), excerpt: item.content.slice(0, 1800), evidenceLevel: 'snippet' as const,
        originGroupId: createHash('sha256').update(item.content.toLowerCase().replace(/\W/g, '').slice(0, 500)).digest('hex').slice(0, 16) }]
    })
    const value: SearchResult = { ...base, status: sources.length ? 'ok' : 'empty', sources }
    if (cache.size >= 200) cache.delete(cache.keys().next().value!)
    cache.set(cacheKey, { expires: Date.now() + 3_600_000, value })
    return value
  } catch (error) {
    signal?.throwIfAborted()
    return { ...base, status: 'error', error: error instanceof Error && error.name === 'TimeoutError' ? '联网搜索超时' : '联网搜索网络或协议错误' }
  }
}
export function createSearchSession(tool: SearchTool = webSearch, mode: 'off' | 'auto' | 'required' = 'auto', signal?: AbortSignal) {
  let used = 0, started: number | undefined
  const results: SearchResult[] = []
  const requests = new Map<string,SearchResult>()
  return {
    results,
    async search(request: SearchRequest): Promise<SearchResult> {
      const key = JSON.stringify(request)
      const existing = requests.get(key)
      if (existing) return existing
      const fallback: SearchResult = { purpose: request.purpose, query: request.query, windowDays: request.purpose === 'news' ? request.windowDays || 7 : null, sources: [], status: 'skipped' }
      if (mode === 'off') return fallback
      started ??= Date.now()
      if (used >= 6 || Date.now() - started >= 45000) {
        const limited: SearchResult = {...fallback, status:'error', error:'已达到每视频6次/45秒搜索预算'}
        results.push(limited)
        return limited
      }
      used++
      const requestSignal = combineSignal(signal, Math.max(1, 45000 - (Date.now() - started)))
      let result:SearchResult
      try { result = await tool(request, requestSignal) }
      catch { signal?.throwIfAborted(); result={...fallback,status:'error',error:'联网搜索失败或步骤超时'} }
      requests.set(key,result)
      results.push(result)
      return result
    },
  }
}
