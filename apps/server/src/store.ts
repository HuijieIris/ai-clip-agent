import './env'
import { mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Project, FrameTemplate, ExportJob, LibraryAsset } from './types'
import { openStorage } from './storage'
import type { Storage } from './storage'
export const DATA_DIR = process.env.APP_DATA_DIR || join(import.meta.dir, '..', 'data')
export const UPLOAD_DIR = join(DATA_DIR, 'uploads'),
  OUTPUT_DIR = join(DATA_DIR, 'outputs')
for (const d of [DATA_DIR, UPLOAD_DIR, OUTPUT_DIR, join(UPLOAD_DIR, 'frames')])
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
let storage: Storage | undefined
export function getStorage() {
  if (!storage) {
    storage = openStorage(DATA_DIR)
    const db = storage
    if (!db.get<{ id: string }>('domain_migrations', 'editing_v1'))
      db.transaction(() => {
        for (const t of db.all<FrameTemplate>('templates')) {
          t.version ??= 1
          t.channelIds ??= []
          db.put('templates', t)
        }
        for (const p of db.all<Project>('projects')) {
          const t = p.templateId ? db.get<FrameTemplate>('templates', p.templateId) : undefined
          if (!p.brand && t) {
            p.brand = { channelId: null, template: structuredClone(t), confirmedAt: null, revision: 0 }
            db.put('projects', p)
          }
        }
        // A crashed rendering/analysis task is retryable, never silently reported successful.
        for (const job of db.all<ExportJob>('exports'))
          if (job.status === 'queued' || job.status === 'rendering') {
            job.status = 'failed'
            job.message = '数据升级前的任务已中断，可重试'
            db.put('exports', job)
          }
        db.put('domain_migrations', { id: 'editing_v1', at: Date.now() })
      })
  }
  return storage
}
export function transaction<T>(fn: () => T) {
  return getStorage().transaction(fn)
}
export class Store<T extends { id: string }> {
  constructor(private name: string) {}
  all(): T[] {
    return getStorage().all<T>(this.name)
  }
  get(id: string): T | undefined {
    return getStorage().get<T>(this.name, id)
  }
  put(item: T): T {
    return getStorage().put(this.name, item)
  }
  patch(id: string, patch: Partial<T>): T | undefined {
    return transaction(() => {
      const item = this.get(id)
      if (!item) return
      Object.assign(item, patch)
      return this.put(item)
    })
  }
  remove(id: string) {
    getStorage().remove(this.name, id)
  }
}
export const projects = new Store<Project>('projects'),
  templates = new Store<FrameTemplate>('templates'),
  exports_ = new Store<ExportJob>('exports'),
  assets = new Store<LibraryAsset>('assets')
export function uid(prefix = '') {
  return prefix + crypto.randomUUID().replaceAll('-', '').slice(0, 16)
}
