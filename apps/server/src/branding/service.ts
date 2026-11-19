import { loadImage } from '@napi-rs/canvas'
import { join } from 'node:path'
import { UPLOAD_DIR } from '../store'
import { CHANNELS } from '../../../../packages/shared/editing'
import type { ChannelId } from '../../../../packages/shared/editing'
import type { FrameTemplate, Project } from '../types'
import { projects, templates, transaction } from '../store'
import { EditError } from '../editing/plan'
export function validateTemplate(t: FrameTemplate): FrameTemplate {
  if (!t.name?.trim() || !t.coverFrameUrl || !t.bodyFrameUrl)
    throw new EditError('模板名称、封面和正文包框都必填')
  if (
    ![t.coverFrameUrl, t.bodyFrameUrl].every(
      (u) => typeof u === 'string' && u.startsWith('/files/uploads/frames/'),
    )
  )
    throw new EditError('包框应使用已上传的本地素材')
  if (
    !t.canvas ||
    ![t.canvas.width, t.canvas.height].every((v) => Number.isInteger(v) && v >= 16 && v <= 8192)
  )
    throw new EditError('模板画布尺寸无效')
  for (const r of [t.videoViewport, t.subtitleSafeArea, t.coverTitleSafeArea]) {
    if (
      !r ||
      ![r.x, r.y, r.width, r.height].every(Number.isFinite) ||
      r.x < 0 ||
      r.y < 0 ||
      r.width <= 0 ||
      r.height <= 0 ||
      r.x + r.width > t.canvas.width ||
      r.y + r.height > t.canvas.height
    )
      throw new EditError('模板视频区和安全区必须位于画布内')
  }
  if (t.channelIds && !t.channelIds.every((id) => CHANNELS.some((c) => c.id === id)))
    throw new EditError('模板频道无效')
  return t
}
export function templateFor(project: Project): FrameTemplate | undefined {
  return project.brand?.template || (project.templateId ? templates.get(project.templateId) : undefined)
}
export function makeBrand(
  channelId: unknown,
  templateId: string,
  confirmed: boolean,
  revision = 0,
): NonNullable<Project['brand']> {
  if (!CHANNELS.some((c) => c.id === channelId)) throw new EditError('请选择科技、AI、机器人或财经频道')
  if (!confirmed) throw new EditError('请确认本任务的封面与正文包框')
  const template = templates.get(templateId)
  if (!template) throw new EditError('包框模板不存在', 404)
  validateTemplate(template)
  if (template.channelIds?.length && !template.channelIds.includes(channelId as ChannelId))
    throw new EditError('模板与所选频道不匹配')
  return {
    channelId: channelId as ChannelId,
    template: structuredClone(template),
    confirmedAt: Date.now(),
    revision: revision + 1,
  }
}
export function bindBrand(
  projectId: string,
  body: { channelId: unknown; templateId: string; confirmed: boolean; expectedRevision?: number },
) {
  return transaction(() => {
    const p = projects.get(projectId)
    if (!p) throw new EditError('项目不存在', 404)
    if (body.expectedRevision !== undefined && body.expectedRevision !== (p.brand?.revision || 0))
      throw new EditError('品牌配置已更新，请刷新后确认', 409)
    p.brand = makeBrand(body.channelId, body.templateId, body.confirmed, p.brand?.revision || 0)
    p.templateId = body.templateId
    const channel = CHANNELS.find((c) => c.id === p.brand!.channelId)!
    p.recommendationSettings = {
      ...p.recommendationSettings,
      profile: `凤凰网${channel.name}；${channel.audience}；${channel.editorialGoals}`,
    }
    p.updatedAt = Date.now()
    projects.put(p)
    return p
  })
}

/** Uploaded artwork is the source of truth for canvas dimensions. */
export async function adaptCanvasToFrame(t: FrameTemplate): Promise<FrameTemplate> {
  const read = async (url: string | null) => {
    if (!url?.startsWith('/files/uploads/frames/')) throw new EditError('请上传有效包框图片')
    try { return await loadImage(join(UPLOAD_DIR, 'frames', url.split('/').pop()!)) }
    catch { throw new EditError('包框图片无法读取，请重新上传') }
  }
  const [body, cover] = await Promise.all([read(t.bodyFrameUrl), read(t.coverFrameUrl)])
  if(Math.abs(body.width/body.height-cover.width/cover.height)>.001)throw new EditError('封面与正文包框比例不同，请上传同比例图片，避免包框变形')
  const sx=body.width/t.canvas.width,sy=body.height/t.canvas.height
  for(const r of [t.videoViewport,t.subtitleSafeArea,t.coverTitleSafeArea]){
    r.x=Math.round(r.x*sx);r.y=Math.round(r.y*sy);r.width=Math.round(r.width*sx);r.height=Math.round(r.height*sy)
  }
  t.canvas={width:body.width,height:body.height}
  return t
}
