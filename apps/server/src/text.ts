/**
 * 转写文本的确定性后处理。
 *
 * ASR（尤其火山/FunASR 的 utterance）常把一整段话当成一句返回，
 * 直接拿去当字幕会出现「一行字挂屏十秒」的情况。
 * 这里按标点切成句级片段，并按字数比例重新分配时间轴，
 * 让字幕既读得过来，又不会整体错位。
 */

/** 句末标点（中英文） */
const TERMINATORS = '。！？!?…；;'
/** 句末标点后可能紧跟的收尾符号，应留在同一句里 */
const CLOSERS = '”’"\'」』）)】》'

const TERM_CLASS = `[${TERMINATORS}]`
const CLOSER_CLASS = `[${escapeClass(CLOSERS)}]`
// 在句末标点（含其后的收尾符号）之后插入分隔符
const SENT_RE = new RegExp(`(${TERM_CLASS}+${CLOSER_CLASS}*)`, 'g')
// 次级断点：逗号、顿号、冒号
const CLAUSE_RE = /(?<=[，,、：:])/

function escapeClass(s: string): string {
  return s.replace(/[\\\]^-]/g, '\\$&')
}

/** 按标点切成句子，保留原标点 */
export function splitSentences(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, '\n').trim()
  if (!normalized) return []

  const out: string[] = []
  for (const line of normalized.split('\n')) {
    const marked = line.replace(SENT_RE, '$1\u0000').replace(/(\.["')\]]*)(?=\s+[A-Z]|$)/g, '$1\u0000')
    for (const piece of marked.split('\u0000')) {
      const t = piece.trim()
      if (t) out.push(t)
    }
  }
  return out
}

/** 把超长句子继续按逗号/顿号拆开，再不行就硬切 */
function splitLongSentence(sentence: string, maxChars: number): string[] {
  if (sentence.length <= maxChars) return [sentence]

  const clauses = sentence.split(CLAUSE_RE).filter(Boolean)
  const merged: string[] = []
  let cur = ''
  for (const c of clauses) {
    if (!cur) {
      cur = c
    } else if (cur.length + c.length <= maxChars) {
      cur += c
    } else {
      merged.push(cur)
      cur = c
    }
  }
  if (cur) merged.push(cur)

  // 仍然超长的（一整句没有逗号），硬切，避免单条字幕塞满整屏
  const out: string[] = []
  for (const m of merged) {
    if (m.length <= maxChars) {
      out.push(m)
      continue
    }
    let rest = m
    while (rest.length > maxChars) {
      const space = rest.lastIndexOf(' ', maxChars)
      const cut = space > maxChars / 2 ? space + 1 : maxChars
      out.push(rest.slice(0, cut)); rest = rest.slice(cut)
    }
    if (rest) out.push(rest)
  }
  return out
}

export interface TimedText {
  start: number
  end: number
  text: string
}

/** 每个片段保证的最短时长，避免字少的句子一闪而过 */
const MIN_PIECE_MS = 320

/**
 * 把一段（可能很长的）转写结果切成句级片段，并按字数比例分配时间。
 *
 * @param seg      原始片段（ASR utterance）
 * @param maxChars 单条字幕建议最大字数，默认 20（中文一行的舒适阅读量）
 */
export function splitTimedSegment(seg: TimedText, maxChars = 20): TimedText[] {
  const latin = (seg.text.match(/[A-Za-z]/g) || []).length
  const han = (seg.text.match(/\p{Script=Han}/gu) || []).length
  if (latin > han * 2) maxChars = Math.max(72, maxChars)
  const sentences = splitSentences(seg.text)
  if (sentences.length === 0) return []

  const pieces: string[] = []
  for (const s of sentences) pieces.push(...splitLongSentence(s, maxChars))

  // 只有一句且字数不变，直接原样返回，避免无谓的时间重算
  if (pieces.length === 1 && pieces[0] === seg.text.trim()) return [{ ...seg, text: pieces[0] }]

  const total = Math.max(0, seg.end - seg.start)
  const totalChars = pieces.reduce((n, p) => n + p.length, 0) || 1

  const out: TimedText[] = []
  let acc = 0
  for (let i = 0; i < pieces.length; i++) {
    const before = Math.round((acc / totalChars) * total)
    acc += pieces[i].length
    const after = i === pieces.length - 1 ? total : Math.round((acc / totalChars) * total)
    out.push({ start: seg.start + before, end: seg.start + after, text: pieces[i] })
  }

  // 时间兜底：把过短的片段从后一片借时间，保证不出现 0 时长字幕
  for (let i = 0; i < out.length - 1; i++) {
    if (out[i].end - out[i].start < MIN_PIECE_MS) {
      const need = MIN_PIECE_MS - (out[i].end - out[i].start)
      const borrow = Math.min(need, Math.max(0, out[i + 1].end - out[i + 1].start - MIN_PIECE_MS))
      if (borrow > 0) {
        out[i].end += borrow
        out[i + 1].start += borrow
      }
    }
  }

  return out.filter((p) => p.text.trim() && p.end > p.start)
}

/** 文本去标点后用于相似度比较 */
function normalizeForCompare(text: string): string {
  return text.replace(/[\s，。！？、；：""''（）()【】\[\]…—\-·,.!?;:]/g, '')
}

/** 字级 2-gram 集合 */
function bigrams(s: string): Set<string> {
  const out = new Set<string>()
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2))
  return out
}

/** Jaccard 相似度，0-1 */
export function similarity(a: string, b: string): number {
  const x = normalizeForCompare(a)
  const y = normalizeForCompare(b)
  if (!x || !y) return 0
  if (x === y) return 1
  if (x.length < 2 || y.length < 2) return 0
  const A = bigrams(x)
  const B = bigrams(y)
  let inter = 0
  for (const g of A) if (B.has(g)) inter++
  const union = A.size + B.size - inter
  return union === 0 ? 0 : inter / union
}

/**
 * 分片拼接处去重。
 *
 * 固定时长切片会把一句话从中间切断，下一片会重新听到半句，
 * 表现为相邻两条字幕内容高度相似。这里把间隔很近且高度相似的重复项去掉。
 */
export function dedupeAdjacent<T extends TimedText>(items: T[], opts?: { gapMs?: number; threshold?: number }): T[] {
  const gapMs = opts?.gapMs ?? 1200
  const threshold = opts?.threshold ?? 0.62
  const out: T[] = []
  for (const cur of items) {
    const prev = out[out.length - 1]
    if (prev && cur.start - prev.end <= gapMs && similarity(prev.text, cur.text) >= threshold) {
      // 保留更长、信息量更大的那条
      if (normalizeForCompare(cur.text).length > normalizeForCompare(prev.text).length) out[out.length - 1] = cur
      continue
    }
    out.push(cur)
  }
  return out
}
