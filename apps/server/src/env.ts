/**
 * 环境变量加载。
 *
 * Bun 只会自动加载「进程工作目录」下的 .env，而本项目的服务端是从
 * apps/server 目录启动的，所以根目录的 .env 不会被读到。
 * 这里显式补上根目录与 apps/server 两处，避免「照 .env.example 配了却不生效」。
 *
 * 规则：已存在的环境变量优先，不会被文件覆盖。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..', '..')
const CANDIDATES = [join(ROOT, '.env'), join(import.meta.dir, '..', '.env')]

function parseEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let val = line.slice(eq + 1).trim()
    // 去掉包裹引号
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (key) out[key] = val
  }
  return out
}

let loaded: string[] = []
for (const file of CANDIDATES) {
  if (!existsSync(file)) continue
  try {
    const vars = parseEnv(readFileSync(file, 'utf8'))
    for (const [k, v] of Object.entries(vars)) {
      if (process.env[k] === undefined || process.env[k] === '') process.env[k] = v
    }
    loaded.push(file)
  } catch (e: any) {
    console.error(`[env] 读取 ${file} 失败：${e?.message ?? e}`)
  }
}

export const envFilesLoaded = loaded
