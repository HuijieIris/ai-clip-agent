import { CHANNELS } from '../../../../packages/shared/editing'
import type { ChannelId } from '../../../../packages/shared/editing'
import { useRef, useState } from 'react'
import { api } from '../api'
import type { FrameTemplate, LibraryAsset } from '../types'
import { Alert, Field, Modal } from '../ui/kit'
import { IconUpload, IconLoader, IconX, IconCheck, IconFrame } from '../ui/icons'
import { useToast } from '../ui/toast'

type Slot = 'cover' | 'body'

interface Props {
  open: boolean
  onClose: () => void
  onCreated: (t: FrameTemplate) => void
}

const DEFAULT_CANVAS = { width: 1080, height: 1920 }

export function FrameTemplateDialog({ open, onClose, onCreated }: Props) {
  const toast = useToast()
  const [channelIds,setChannelIds]=useState<ChannelId[]>([])
  const [name, setName] = useState('')
  const [cover, setCover] = useState<LibraryAsset | null>(null)
  const [body, setBody] = useState<LibraryAsset | null>(null)
  const [uploading, setUploading] = useState<Slot | null>(null)
  const [preview, setPreview] = useState<Slot>('body')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [viewport, setViewport] = useState({ x: 40, y: 300, width: 1000, height: 1340 })
  const [subtitle, setSubtitle] = useState({ x: 90, y: 1520, width: 900, height: 240 })
  const [coverTitle, setCoverTitle] = useState({ x: 100, y: 220, width: 880, height: 520 })
  const [advanced, setAdvanced] = useState(false)
  const coverRef = useRef<HTMLInputElement>(null)
  const bodyRef = useRef<HTMLInputElement>(null)

  const reset = () => {
    setChannelIds([])
    setName('')
    setCover(null)
    setBody(null)
    setErr(null)
    setAdvanced(false)
    setViewport({ x: 40, y: 300, width: 1000, height: 1340 })
    setSubtitle({ x: 90, y: 1520, width: 900, height: 240 })
    setCoverTitle({ x: 100, y: 220, width: 880, height: 520 })
  }

  const upload = async (file: File, slot: Slot) => {
    setErr(null)
    const okTypes = ['image/png', 'image/svg+xml', 'image/webp', 'image/jpeg']
    if (!okTypes.includes(file.type)) {
      setErr(`包框需为透明 PNG / SVG / WebP，当前文件类型 ${file.type || '未知'}`)
      return
    }
    setUploading(slot)
    try {
      const asset = await api.uploadAsset(file)
      if (slot === 'cover') setCover(asset)
      else setBody(asset)
      if (!name) setName(file.name.replace(/\.[^.]+$/, ''))
    } catch (e: any) {
      setErr(e.message)
    } finally {
      setUploading(null)
    }
  }

  const canSave = name.trim().length > 0 && !!cover && !!body && !saving

  const save = async () => {
    if (!cover || !body) return
    setSaving(true)
    setErr(null)
    try {
      const t = await api.createTemplate({
        name: name.trim(), channelIds,
        canvas: DEFAULT_CANVAS,
        coverFrameAssetId: cover.id,
        coverFrameUrl: cover.url,
        bodyFrameAssetId: body.id,
        bodyFrameUrl: body.url,
        videoViewport: viewport,
        subtitleSafeArea: subtitle,
        coverTitleSafeArea: coverTitle,
        defaultTransform: { scale: 1, offsetX: 0, offsetY: 0 },
      })
      reset()
      onCreated(t)
    } catch (e: any) {
      setErr(e.message)
    } finally {
      setSaving(false)
    }
  }

  const activeUrl = preview === 'body' ? body?.url : cover?.url
  const activeArea = preview === 'body' ? viewport : coverTitle
  const safeArea = preview === 'body' ? subtitle : null

  return (
    <Modal
      open={open}
      title="新建视频包框模板"
      sub="封面包框与正文包框需分别上传，保存一次即可重复用于所有视频"
      onClose={() => {
        if (!saving) onClose()
      }}
      width={1060}
      footer={
        <>
          <div className="tiny muted">
            {!cover && '缺少封面包框'} {!cover && !body && '、'} {!body && '缺少正文包框'}
            {cover && body && !name.trim() && '请填写模板名称'}
            {canSave && '校验通过，可保存'}
          </div>
          <div className="spacer" />
          <button className="btn btn-ghost" onClick={onClose} disabled={saving}>取消</button>
          <button className="btn btn-primary" disabled={!canSave} onClick={save}>
            {saving ? <IconLoader size={15} /> : <IconCheck size={15} />}
            {saving ? '保存中…' : '保存并使用'}
          </button>
        </>
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 300px', gap: 18 }}>
        <div className="col" style={{ gap: 14 }}>
          <div className="row">适用频道（不选为通用）：{CHANNELS.map(c=><label key={c.id} className="tiny"><input type="checkbox" checked={channelIds.includes(c.id)} onChange={e=>setChannelIds(old=>e.target.checked?[...old,c.id]:old.filter(id=>id!==c.id))}/>{c.name}</label>)}</div>
          <Field label="模板名称" required>
            <input
              className="input"
              placeholder="例如：我的账号竖屏包框"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={40}
            />
          </Field>

          <FrameSlot
            title="封面包框"
            hint="用于视频首屏与导出封面，建议透明 PNG"
            asset={cover}
            busy={uploading === 'cover'}
            onClick={() => coverRef.current?.click()}
            onClear={() => setCover(null)}
            required
          />
          <input
            ref={coverRef}
            type="file"
            accept="image/png,image/svg+xml,image/webp"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void upload(f, 'cover')
              e.target.value = ''
            }}
          />
        </div>

        <div className="col" style={{ gap: 14 }}>
          <Field label="目标画幅">
            <div className="row" style={{ gap: 6 }}>
              <span className="chip on mono">1080 × 1920</span>
              <span className="tiny muted">竖屏 9:16</span>
            </div>
          </Field>

          <FrameSlot
            title="正文包框"
            hint="叠加在视频画面之上的固定框层"
            asset={body}
            busy={uploading === 'body'}
            onClick={() => bodyRef.current?.click()}
            onClear={() => setBody(null)}
            required
          />
          <input
            ref={bodyRef}
            type="file"
            accept="image/png,image/svg+xml,image/webp"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void upload(f, 'body')
              e.target.value = ''
            }}
          />
        </div>

        <div>
          <div className="row" style={{ gap: 6, marginBottom: 10 }}>
            <button className={`chip ${preview === 'cover' ? 'on' : ''}`} onClick={() => setPreview('cover')}>
              封面预览
            </button>
            <button className={`chip ${preview === 'body' ? 'on' : ''}`} onClick={() => setPreview('body')}>
              正文预览
            </button>
          </div>
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <div className="phone" style={{ maxWidth: 210 }}>
              {/* 示例人物画面 */}
              <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(165deg,#243040 0%,#141a23 55%,#0c1015 100%)' }} />
              <div
                style={{
                  position: 'absolute', left: '34%', top: '26%', width: '32%', height: '30%', borderRadius: '50% 50% 42% 42%',
                  background: 'radial-gradient(circle at 40% 35%, #3f4c5e, #26303c)',
                }}
              />
              <div
                style={{
                  position: 'absolute', left: '26%', top: '54%', width: '48%', height: '34%',
                  borderRadius: '40% 40% 10% 10%', background: 'radial-gradient(circle at 50% 20%, #334050, #1c242e)',
                }}
              />
              {/* 安全区可视化 */}
              <div
                style={{
                  position: 'absolute',
                  left: `${(activeArea.x / DEFAULT_CANVAS.width) * 100}%`,
                  top: `${(activeArea.y / DEFAULT_CANVAS.height) * 100}%`,
                  width: `${(activeArea.width / DEFAULT_CANVAS.width) * 100}%`,
                  height: `${(activeArea.height / DEFAULT_CANVAS.height) * 100}%`,
                  border: '1px dashed rgba(201,255,77,.55)',
                  background: 'rgba(201,255,77,.05)',
                  borderRadius: 3,
                  fontSize: 8,
                  color: 'rgba(201,255,77,.85)',
                  padding: 3,
                }}
              >
                {preview === 'body' ? '视频区' : '标题安全区'}
              </div>
              {safeArea && (
                <div
                  style={{
                    position: 'absolute',
                    left: `${(safeArea.x / DEFAULT_CANVAS.width) * 100}%`,
                    top: `${(safeArea.y / DEFAULT_CANVAS.height) * 100}%`,
                    width: `${(safeArea.width / DEFAULT_CANVAS.width) * 100}%`,
                    height: `${(safeArea.height / DEFAULT_CANVAS.height) * 100}%`,
                    border: '1px dashed rgba(169,178,192,.45)',
                    borderRadius: 3,
                    fontSize: 8,
                    color: 'rgba(169,178,192,.8)',
                    padding: 3,
                  }}
                >
                  字幕安全区
                </div>
              )}
              {activeUrl && (
                <img
                  src={activeUrl}
                  alt=""
                  style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', pointerEvents: 'none' }}
                />
              )}
            </div>
          </div>
          <div className="tiny muted" style={{ textAlign: 'center', marginTop: 10, lineHeight: 1.7 }}>
            {activeUrl ? '透明区域会露出下层视频画面' : '上传后此处显示包框效果'}
          </div>
        </div>
      </div>

      {err && (
        <div style={{ marginTop: 14 }}>
          <Alert kind="error" title="无法保存">{err}</Alert>
        </div>
      )}

      <div className="divider" style={{ margin: '16px 0' }} />
      <button className="btn btn-ghost btn-sm" onClick={() => setAdvanced((v) => !v)}>
        {advanced ? '收起高级配置' : '高级配置：视频显示区 / 安全区'}
      </button>
      {advanced && (
        <div className="grid-3" style={{ marginTop: 12 }}>
          <BoxEditor label="视频显示区域" value={viewport} onChange={setViewport} />
          <BoxEditor label="字幕安全区" value={subtitle} onChange={setSubtitle} />
          <BoxEditor label="标题安全区" value={coverTitle} onChange={setCoverTitle} />
        </div>
      )}
    </Modal>
  )
}

function FrameSlot({
  title, hint, asset, busy, onClick, onClear, required,
}: {
  title: string
  hint: string
  asset: LibraryAsset | null
  busy: boolean
  onClick: () => void
  onClear: () => void
  required?: boolean
}) {
  return (
    <div>
      <div className="row" style={{ marginBottom: 6 }}>
        <span className="label" style={{ margin: 0 }}>
          {title} {required && <span className="req">*</span>}
        </span>
        {asset && <span className="badge badge-success" style={{ marginLeft: 'auto', height: 19 }}><IconCheck size={10} /> 已上传</span>}
      </div>
      <div
        className={`dropzone ${asset ? 'has' : ''}`}
        style={{ minHeight: 150, padding: '16px' }}
        onClick={asset ? undefined : onClick}
      >
        {busy ? (
          <>
            <IconLoader size={20} />
            <div className="tiny muted">上传中…</div>
          </>
        ) : asset ? (
          <div style={{ width: '100%' }}>
            <div
              style={{
                height: 108, borderRadius: 8, background: '#0e131a', display: 'grid', placeItems: 'center', overflow: 'hidden',
                border: '1px solid var(--border-soft)',
                backgroundImage: 'repeating-conic-gradient(from 0deg, rgba(255,255,255,.04) 0% 25%, transparent 0% 50%)',
                backgroundSize: '12px 12px',
              }}
            >
              <img src={asset.url} alt="" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
            </div>
            <div className="row" style={{ marginTop: 8 }}>
              <span className="tiny muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                {asset.name}
              </span>
              <button
                className="btn btn-sm btn-ghost"
                onClick={(e) => {
                  e.stopPropagation()
                  onClear()
                }}
              >
                <IconX size={12} />
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="empty-icon" style={{ width: 40, height: 40 }}>
              <IconUpload size={17} />
            </div>
            <div style={{ fontWeight: 600, fontSize: 13 }}>上传{title}</div>
            <div className="tiny muted">{hint}</div>
          </>
        )}
      </div>
    </div>
  )
}

function BoxEditor({
  label, value, onChange,
}: {
  label: string
  value: { x: number; y: number; width: number; height: number }
  onChange: (v: { x: number; y: number; width: number; height: number }) => void
}) {
  const keys: (keyof typeof value)[] = ['x', 'y', 'width', 'height']
  return (
    <div className="card card-pad" style={{ background: 'var(--bg-app)' }}>
      <div className="tiny" style={{ fontWeight: 600, marginBottom: 8 }}>
        <IconFrame size={11} /> {label}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
        {keys.map((k) => (
          <label key={k} className="col" style={{ gap: 2 }}>
            <span className="tiny muted">{k === 'x' ? 'X' : k === 'y' ? 'Y' : k === 'width' ? '宽' : '高'}</span>
            <input
              className="input input-sm mono"
              type="number"
              value={value[k]}
              onChange={(e) => onChange({ ...value, [k]: Number(e.target.value) || 0 })}
            />
          </label>
        ))}
      </div>
    </div>
  )
}
