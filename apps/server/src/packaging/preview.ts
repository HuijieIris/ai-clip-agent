import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Packaging } from '../../../../packages/shared/packaging'
import { outputSubtitles, subtitleStyleFor } from '../../../../packages/shared/packaging'
import { projects, OUTPUT_DIR } from '../store'
import { viewClip } from '../editing/service'
import { templateFor } from '../branding/service'
import { validatePackaging } from './service'
import { renderCuePng, renderTitlePng, renderSubtitlePng } from '../subtitles'
import { EditError } from '../editing/plan'
export async function previewText(pid: string, cid: string, p: Packaging, time: number) {
  const project = projects.get(pid),
    stored = project?.clips.find((c) => c.id === cid)
  if (!project || !stored) throw new EditError('项目或片段不存在', 404)
  const clip = viewClip(project, stored),
    tpl = templateFor(project)
  if (!tpl) throw new EditError('模板缺失')
  validatePackaging(p, clip)
  const W = tpl.canvas.width,
    H = tpl.canvas.height
  const cue = outputSubtitles({ ...clip, packaging: p }).find((c) => time >= c.start && time < c.end)
  const image = (kind: string, data: unknown, draw: (path: string) => void) => {
    const name = `text_${createHash('sha256')
        .update(JSON.stringify(['news-words-v3-outline',kind, W, H, data]))
        .digest('hex')
        .slice(0, 32)}.png`,
      path = join(OUTPUT_DIR, name)
    if (!existsSync(path)) draw(path)
    return `/files/outputs/${name}`
  }
  try {
    return {
      cover: p.coverTitle
        ? image('cover', [p.coverTitle, p.coverStyle], (path) =>
            renderTitlePng(p.coverTitle, W, H, path, p.coverStyle, W),
          )
        : null,
      body:
        p.bodyTitle && p.bodyMode !== 'off' && (!p.titleRange || time>=p.titleRange.start&&time<p.titleRange.end) && (p.bodyMode === 'all' || time < p.bodyIntroMs)
          ? image('body', [p.bodyTitle, p.bodyStyle], (path) =>
              renderTitlePng(p.bodyTitle, W, H, path, p.bodyStyle, W),
            )
          : null,
      subtitle: cue?.text
        ? await (async () => {
            const name = `text_${createHash('sha256')
                .update(
                  JSON.stringify([
                    'bilingual-v2-small',
                    W,
                    H,
                    cue.text,
                    cue.english,
                    subtitleStyleFor(p),
                    'highlights' in cue ? cue.highlights : [],
                  ]),
                )
                .digest('hex')
                .slice(0, 32)}.png`,
              path = join(OUTPUT_DIR, name)
            if (!existsSync(path))
              await renderSubtitlePng(
                cue.text,
                cue.english,
                W,
                H,
                path,
                subtitleStyleFor(p),
                W,
                'highlights' in cue ? (cue.highlights as string[]) : [],
              )
            return `/files/outputs/${name}`
          })()
        : null,
    }
  } catch (error) {
    throw new EditError(error instanceof Error ? error.message : '文字排版失败')
  }
}
