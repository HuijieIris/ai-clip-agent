import { CHANNELS } from '../../../../packages/shared/editing'
import type { ChannelId } from '../../../../packages/shared/editing'
import type { FrameTemplate } from '../types'

export function BrandSetup({
  channelId,
  onChannel,
  template,
  templates,
  onTemplate,
  confirmed,
  onConfirm,
}: {
  channelId: ChannelId
  onChannel: (id: ChannelId) => void
  template: FrameTemplate | null
  templates: FrameTemplate[]
  onTemplate: (id: string) => void
  confirmed: boolean
  onConfirm: (value: boolean) => void
}) {
  const recommended = templates.filter((t) => t.channelIds?.includes(channelId))
  const compatible = !!template && (!template.channelIds?.length || template.channelIds.includes(channelId))
  return (
    <section className="panel" style={{ padding: 16, margin: '12px 0' }} aria-label="频道与品牌确认">
      <label>
        频道{' '}
        <select className="input" value={channelId} onChange={(e) => onChannel(e.target.value as ChannelId)}>
          {CHANNELS.map((c) => (
            <option key={c.id} value={c.id}>
              凤凰网{c.name}
            </option>
          ))}
        </select>
      </label>
      <div className="tiny secondary" style={{ margin: '8px 0' }}>
        {CHANNELS.find((c) => c.id === channelId)?.editorialGoals}
      </div>
      <div className="tiny">
        {recommended.length ? '推荐频道模板：' : '尚未配置该频道专属模板，可选择通用模板并确认。'}
        {recommended.map((t) => (
          <button type="button" className="btn btn-sm btn-ghost" key={t.id} onClick={() => onTemplate(t.id)}>
            {t.name} · v{t.version ?? 1}
          </button>
        ))}
      </div>
      {!compatible && template && (
        <p className="tiny" role="alert">
          当前模板属于其他频道，请更换。
        </p>
      )}
      {template && (
        <div className="row" style={{ gap: 8, margin: '8px 0' }}>
          {[
            ['封面', template.coverFrameUrl],
            ['正文', template.bodyFrameUrl],
          ].map(([name, url]) => (
            <figure key={name} style={{ margin: 0 }}>
              <img
                src={url ?? undefined}
                alt={`${name}包框`}
                style={{ height: 100, width: 64, objectFit: 'contain', background: '#333' }}
              />
              <figcaption className="tiny">{name}</figcaption>
            </figure>
          ))}
        </div>
      )}
      <label className="tiny">
        <input
          type="checkbox"
          disabled={!compatible}
          checked={compatible && confirmed}
          onChange={(e) => onConfirm(e.target.checked)}
        />{' '}
        已确认频道和「{template?.name ?? '未选模板'}」的封面、正文包框，将应用到全部切片
      </label>
    </section>
  )
}
