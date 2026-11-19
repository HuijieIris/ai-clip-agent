import { Database } from 'bun:sqlite'
import { mkdirSync, existsSync, readFileSync, copyFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
const LEGACY = ['projects', 'templates', 'exports', 'assets']
export function openStorage(directory: string) {
  mkdirSync(directory, { recursive: true })
  const database = new Database(join(directory, 'app.sqlite'), { create: true })
  database.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;')
  database.exec(
    `CREATE TABLE IF NOT EXISTS records(collection TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(collection,id)); CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);`,
  )
  const imported = database.query('SELECT value FROM meta WHERE key=?').get('json_import_v1') as {
    value: string
  } | null
  try {
    if (!imported) {
      const inputs = LEGACY.map((name) => {
        const path = join(directory, `${name}.json`)
        if (!existsSync(path)) return { name, path, raw: null, items: [] as { id: string }[] }
        const raw = readFileSync(path, 'utf8'),
          items = JSON.parse(raw)
        if (
          !Array.isArray(items) ||
          items.some((v) => !v || typeof v.id !== 'string' || !v.id) ||
          new Set(items.map((v) => v.id)).size !== items.length
        )
          throw new Error(`${name}.json 结构无效或ID重复，已停止迁移；原文件未修改`)
        return { name, path, raw, items: items as { id: string }[] }
      })
      const backup = join(directory, 'backups', `json-${Date.now()}-${randomUUID().slice(0, 8)}`)
      mkdirSync(backup, { recursive: true })
      for (const input of inputs)
        if (input.raw !== null) copyFileSync(input.path, join(backup, `${input.name}.json`))
      const report = {
        at: Date.now(),
        backup,
        collections: inputs.map((i) => ({
          name: i.name,
          count: i.items.length,
          sha256: i.raw === null ? null : createHash('sha256').update(i.raw).digest('hex'),
        })),
      }
      database
        .transaction(() => {
          if ((database.query('SELECT count(*) AS n FROM records').get() as { n: number }).n)
            throw new Error('发现未标记迁移的非空数据库，拒绝覆盖')
          const insert = database.query('INSERT INTO records(collection,id,data) VALUES (?,?,?)')
          for (const input of inputs)
            for (const item of input.items) {
              const json = JSON.stringify(item)
              insert.run(input.name, item.id, json)
              const check = database
                .query('SELECT data FROM records WHERE collection=? AND id=?')
                .get(input.name, item.id) as { data: string }
              if (check.data !== json) throw new Error('迁移回读不一致')
            }
          database
            .query('INSERT INTO meta(key,value) VALUES(?,?)')
            .run('json_import_v1', JSON.stringify(report))
        })
        .immediate()
      writeFileSync(join(backup, 'manifest.json'), JSON.stringify(report, null, 2))
    }
  } catch (error) {
    database.close()
    throw error
  }
  return {
    database,
    transaction<T>(fn: () => T): T {
      return database.transaction(fn).immediate()
    },
    all<T>(collection: string): T[] {
      return (
        database.query('SELECT data FROM records WHERE collection=? ORDER BY rowid').all(collection) as {
          data: string
        }[]
      ).map((r) => JSON.parse(r.data))
    },
    get<T>(collection: string, id: string): T | undefined {
      const r = database
        .query('SELECT data FROM records WHERE collection=? AND id=?')
        .get(collection, id) as { data: string } | null
      return r ? JSON.parse(r.data) : undefined
    },
    put<T extends { id: string }>(collection: string, item: T): T {
      database
        .query(
          'INSERT INTO records(collection,id,data) VALUES(?,?,?) ON CONFLICT(collection,id) DO UPDATE SET data=excluded.data',
        )
        .run(collection, item.id, JSON.stringify(item))
      return item
    },
    remove(collection: string, id: string) {
      database.query('DELETE FROM records WHERE collection=? AND id=?').run(collection, id)
    },
    migration() {
      return JSON.parse(
        (database.query('SELECT value FROM meta WHERE key=?').get('json_import_v1') as { value: string })
          .value,
      )
    },
    close() {
      database.close()
    },
  }
}
export type Storage = ReturnType<typeof openStorage>
