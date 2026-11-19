import { validatePackaging } from '../packaging/service'
import type { Clip, Project, ClipCover } from '../types'
import { Store, projects, templates,transaction, uid } from '../store'
import { ensurePlan, rebuild, deleteOutputRange, EditError } from './plan'
import { mapInterval, timeMap } from '../../../../packages/shared/editing'
interface Snapshot {
  id: string
  clip: Clip
  createdAt: number
}
interface Head {
  id: string
  revision: number
  current: string
  undo: string[]
  redo: string[]
}
const snapshots = new Store<Snapshot>('edit_snapshots'),
  heads = new Store<Head>('edit_heads')
export function viewClip(project: Project, clip: Clip): Clip {
  const result = structuredClone(clip),
    plan = ensurePlan(project, result),
    head = heads.get(clip.id)
  plan.undoCount = head?.undo.length || 0
  plan.redoCount = head?.redo.length || 0
  return rebuild(result, plan, project.duration)
}
export function viewProject(project: Project): Project {
  const visible=project.activeClipIds?project.activeClipIds.flatMap(id=>{const clip=project.clips.find(c=>c.id===id);return clip?[clip]:[]}):project.clips
  return { ...project, clips:visible.map(c=>viewClip(project,c)) }
}
export type Command = { type: string; [key: string]: any }
export function editClip(projectId: string, clipId: string, command: Command): Clip {
  return transaction(() => {
    const p = projects.get(projectId),
      stored = p?.clips.find((c) => c.id === clipId)
    if (!p || !stored) throw new EditError('项目或片段不存在', 404)
    let clip = viewClip(p, stored),
      plan = clip.editPlan!
    if (command.expectedRevision !== undefined && command.expectedRevision !== plan.revision)
      throw new EditError('片段已在其他操作中更新，请刷新后重试', 409)
    let head = heads.get(clipId)
    if (!head) {
      const initial = uid('rev_')
      snapshots.put({
        id: initial,
        clip: { ...structuredClone(clip), operations: [] },
        createdAt: Date.now(),
      })
      head = { id: clipId, revision: plan.revision, current: initial, undo: [], redo: [] }
    }
    const audit = clip.operations || []
    if (command.type === 'undo' || command.type === 'redo') {
      const from = command.type === 'undo' ? head.undo : head.redo,
        to = command.type === 'undo' ? head.redo : head.undo
      const target = from.pop()
      if (!target)
        throw new EditError(command.type === 'undo' ? '没有可精确撤销的新操作' : '没有可重做的操作')
      const snapshot = snapshots.get(target)
      if (!snapshot) throw new EditError('历史快照缺失', 409)
      to.push(head.current)
      head.current = target
      clip = structuredClone(snapshot.clip)
      plan = clip.editPlan!
    } else {
      if(command.type==='restore_framing'){
        const tpl=p.brand?.template??(p.templateId?templates.get(p.templateId):undefined)
        if(!tpl)throw new EditError('原模板不存在')
        if(clip.packaging?.frameLayout){clip.packaging.frameLayout.fit='cover';clip.packaging.frameLayout.bodyViewport={...tpl.videoViewport}}
        const identity=!clip.transform||(clip.transform.scale===1&&clip.transform.offsetX===0&&clip.transform.offsetY===0)
        if(identity){const previous=[...head.undo].reverse().map(id=>snapshots.get(id)?.clip).find(c=>c&&!c.packaging?.frameLayout);clip.transform=structuredClone(previous?.transform??tpl.defaultTransform)}
      } else if (command.type === 'trim') {
        const { start, end } = command
        if (
          !Number.isInteger(start) ||
          !Number.isInteger(end) ||
          start < 0 ||
          end <= start ||
          end > p.duration
        )
          throw new EditError('裁剪时间无效或越界')
        const old = plan.spans
        plan.spans = old.flatMap((s, i) => {
          const a = i === 0 ? start : Math.max(start, s.sourceIn),
            b = i === old.length - 1 ? end : Math.min(end, s.sourceOut)
          return b > a ? [{ ...s, sourceIn: a, sourceOut: b }] : []
        })
      } else if (command.type === 'review_cut') {
        const { start, end, mode } = command
        const duration = plan.durationMs
        const mapped = timeMap(plan.spans)
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > duration || end <= start)
          throw new EditError('请选择有效的视频区间')
        if (mode === 'trim') {
          plan.spans = mapped.flatMap((span) => {
            const from = Math.max(start, span.outputIn)
            const to = Math.min(end, span.outputOut)
            return to > from ? [{
              id: span.id,
              sourceIn: span.sourceIn + from - span.outputIn,
              sourceOut: span.sourceIn + to - span.outputIn,
            }] : []
          })
        } else if (mode === 'delete') {
          plan.spans = deleteOutputRange(plan.spans, start, end)
        } else throw new EditError('不支持的视频区间操作')

        const nextDuration = mode === 'trim' ? end - start : duration - (end - start)
        const remap = (time: number) => mode === 'trim'
          ? Math.max(0, Math.min(nextDuration, time - start))
          : time - Math.max(0, Math.min(time, end) - start)
        const packaging = clip.packaging
        if (packaging) {
          for (const key of ['titleRange', 'subtitleRange'] as const) {
            const range = packaging[key]
            if (!range) continue
            const from = remap(range.start), to = remap(range.end)
            if (to > from) packaging[key] = { start: from, end: to }
            else if (key === 'titleRange') {
              delete packaging.titleRange
              packaging.bodyMode = 'off'
            } else {
              delete packaging.subtitleRange
              packaging.subtitleOffsetMs = nextDuration
            }
          }
          if (packaging.subtitleOffsetMs !== undefined) {
            packaging.subtitleOffsetMs = Math.max(-nextDuration, Math.min(nextDuration, packaging.subtitleOffsetMs))
          }
          if (packaging.bgm) {
            const bgm = packaging.bgm
            const from = remap(bgm.start), to = remap(bgm.end)
            if (to > from) {
              if (mode === 'trim') bgm.sourceIn += Math.max(0, start - bgm.start)
              bgm.start = from
              bgm.end = to
            } else {
              bgm.enabled = false
              bgm.start = 0
              bgm.end = nextDuration
            }
          }
        }
        if (clip.cover?.firstScreenDuration !== undefined)
          clip.cover.firstScreenDuration = Math.min(nextDuration, clip.cover.firstScreenDuration)
      } else if (command.type === 'spans') plan.spans = command.spans
      else if (command.type === 'delete_range')
        plan.spans = deleteOutputRange(plan.spans, command.start, command.end)
      else if (command.type === 'subtitle') {
        const output = clip.subtitles.find((c) => c.id === command.cueId)
        const cue = plan.sourceSubtitles.find((c) => c.id === (output?.sourceCueId || command.cueId))
        if (!cue) throw new EditError('字幕不存在', 404)
        if (typeof command.text !== 'string' || command.text.length > 4000)
          throw new EditError('字幕文字无效')
        cue.text = command.text
      } else if (command.type === 'replace') {
        const r = command.replacement
        if (
          !r ||
          typeof r.assetUrl !== 'string' ||
          !r.assetUrl.startsWith('/files/uploads/') ||
          !Number.isInteger(r.start) ||
          !Number.isInteger(r.end) ||
          r.start < 0 ||
          r.end <= r.start ||
          r.end > plan.durationMs
        )
          throw new EditError('替换素材或成片区间无效')
        for (const span of timeMap(plan.spans)) {
          const a = Math.max(r.start, span.outputIn),
            b = Math.min(r.end, span.outputOut)
          if (b > a)
            plan.sourceReplacements.push({
              ...r,
              id: uid('replace_'),
              start: span.sourceIn + a - span.outputIn,
              end: span.sourceIn + b - span.outputIn,
              assetIn: (r.assetIn || 0) + a - r.start,
              keepAudio: true,
            })
        }
      } else if(command.type==='subtitle_mode'){
        if(!['bilingual','zh','en'].includes(command.mode))throw new EditError('字幕语种无效');clip.subtitleMode=command.mode
      } else if (command.type === 'packaging') {
        const next = validatePackaging(structuredClone(command.packaging), clip)
        for (const cue of next.sourceCues) {
          const original = plan.sourceSubtitles.find((c) => c.id === cue.id)
          if (
            !original ||
            cue.start !== original.start ||
            cue.end !== original.end ||
            cue.original !== original.text
          )
            throw new EditError('中文句子来源或时间不匹配，请刷新后重试')
        }
        clip.packaging = next
      } else if (command.type === 'frame' || command.type === 'presentation') {
        if (command.transform) {
          const t = command.transform
          if (
            ![t.scale, t.offsetX, t.offsetY].every(Number.isFinite) ||
            t.scale < 0.5 ||
            t.scale > 3 ||
            Math.abs(t.offsetX) > 4000 ||
            Math.abs(t.offsetY) > 4000
          )
            throw new EditError('画面缩放或偏移无效')
          clip.transform = structuredClone(t)
        }
        if (command.cover) {
          const c = command.cover,
            t = c.titleStyle
          if (c.title !== undefined && (typeof c.title !== 'string' || c.title.length > 500))
            throw new EditError('封面标题无效')
          if (
            c.firstScreenDuration !== undefined &&
            (!Number.isInteger(c.firstScreenDuration) ||
              c.firstScreenDuration < 0 ||
              c.firstScreenDuration > plan.durationMs)
          )
            throw new EditError('首屏封面时长需在成片范围内')
          if (
            c.imageUrl &&
            (typeof c.imageUrl !== 'string' || !c.imageUrl.startsWith('/files/uploads/frames/'))
          )
            throw new EditError('封面需使用本地上传素材')
          if (
            t &&
            ((t.fontSize !== undefined &&
              (!Number.isFinite(t.fontSize) || t.fontSize < 8 || t.fontSize > 300)) ||
              ['x', 'y'].some(
                (k) => t[k] !== undefined && (!Number.isFinite(t[k]) || t[k] < 0 || t[k] > 1),
              ) ||
              (t.align !== undefined && !['left', 'center', 'right'].includes(t.align)))
          )
            throw new EditError('封面标题样式无效')
        }
        if (command.cover)
          clip.cover = {
            ...(clip.cover || defaultCover(clip)),
            ...command.cover,
            titleStyle: { ...(clip.cover || defaultCover(clip)).titleStyle, ...command.cover.titleStyle },
          }
        clip.status = 'framed'
      } else if (command.type === 'metadata') {
        if (command.title !== undefined) {
          if (typeof command.title !== 'string' || !command.title.trim() || command.title.length > 300)
            throw new EditError('标题无效')
          clip.title = command.title
        }
        if (command.selected !== undefined) clip.selected = Boolean(command.selected)
      } else throw new EditError('不支持的编辑操作')
      if (command.type === 'presentation' && command.packaging) {
        const next = validatePackaging(structuredClone(command.packaging), clip)
        for (const cue of next.sourceCues) {
          const original = plan.sourceSubtitles.find((c) => c.id === cue.id)
          if (
            !original ||
            cue.start !== original.start ||
            cue.end !== original.end ||
            cue.original !== original.text
          )
            throw new EditError('中文字幕源句已改变，请刷新后重新生成')
        }
        clip.packaging = next
      }
      head.undo.push(head.current)
      head.redo = []
    }
    head.revision++
    plan.revision = head.revision
    plan.undoCount = head.undo.length
    plan.redoCount = head.redo.length
    clip = rebuild(clip, plan, p.duration)
    clip.highlightId=stored.highlightId??clip.highlightId
    clip.updatedAt = Date.now()
    if (!['frame', 'presentation', 'undo', 'redo'].includes(command.type)) clip.status = 'edited'
    clip.operations = [
      ...audit,
      {
        id: uid('op_'),
        type:
          (command.type === 'subtitle'||command.type==='subtitle_mode')
            ? 'subtitle'
            : command.type === 'replace'
              ? 'replace'
              : command.type === 'frame'
                ? 'frame'
                : 'trim',
        at: clip.start,
        payload: { command: command.type, revision: plan.revision },
        summary: (
          {
            undo: '撤销',
            redo: '重做',
            delete_range: '删除成片内部区间',
            review_cut: command.mode === 'trim' ? '裁剪视频区间' : '删除视频区间',
            spans: '更新保留区间',
            trim: '调整起止点',
            subtitle: '修改字幕',
            subtitle_mode:'切换字幕语种',
            replace: '替换画面',
            frame: '保存品牌画面设置',
            presentation: '保存中文包装与画面',
            packaging: '更新中文包装',
            metadata: '修改片段信息',
          } as Record<string, string>
        )[command.type],
        createdAt: Date.now(),
        reversible: command.type !== 'undo' && command.type !== 'redo',
        applied: true,
      },
    ]
    if (command.type !== 'undo' && command.type !== 'redo') {
      head.current = uid('rev_')
      snapshots.put({
        id: head.current,
        clip: { ...structuredClone(clip), operations: [] },
        createdAt: Date.now(),
      })
    }
    heads.put(head)
    p.clips = p.clips.map((c) => (c.id === clipId ? clip : c))
    p.updatedAt = Date.now()
    projects.put(p)
    return clip
  })
}
export function defaultCover(clip: Clip): ClipCover {
  return {
    source: 'frame',
    frameTime: clip.start + 500,
    imageUrl: null,
    title: clip.title,
    titleStyle: { fontSize: 64, color: '#FFFFFF', weight: 700, x: 0.5, y: 0.18, align: 'center' },
    firstScreenDuration: 0,
  }
}
