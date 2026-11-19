/**
 * 火山引擎 ASR 凭据自检。
 *
 * 用法：
 *   bun run scripts/verify-volc-asr.ts                 # 用 3 秒测试音（无语音，只验证鉴权）
 *   bun run scripts/verify-volc-asr.ts path/to/audio.wav  # 用真实音频，验证识别质量
 *
 * 注意：脚本会关掉缓存，确保真的打到线上接口。
 */
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { envFilesLoaded } from '../src/env'
import { probe, run } from '../src/ffmpeg'

process.env.ASR_CACHE = '0'

const C = {
  ok: (s: string) => `\x1b[32m${s}\x1b[0m`,
  bad: (s: string) => `\x1b[31m${s}\x1b[0m`,
  warn: (s: string) => `\x1b[33m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
}

console.log(C.bold('\n火山引擎 ASR 自检\n'))

// 1. 环境变量
console.log(C.bold('1) 读取配置'))
const apiKey = process.env.VOLC_API_KEY || ''
const appId = process.env.VOLC_APP_ID || ''
const token = process.env.VOLC_ACCESS_TOKEN || ''
const endpoint = process.env.VOLC_ASR_ENDPOINT || 'https://openspeech.bytedance.com/api/v3/auc/bigmodel'
const resourceId = process.env.VOLC_RESOURCE_ID || 'volc.bigasr.auc'

if (envFilesLoaded.length) {
  for (const f of envFilesLoaded) console.log(C.dim(`   已加载 ${f}`))
} else {
  console.log(C.dim('   未找到任何 .env 文件'))
}

const mask = (v: string) => (v ? `${v.slice(0, 4)}${'*'.repeat(Math.max(0, Math.min(12, v.length - 4)))}（共 ${v.length} 位）` : '')
console.log(`   VOLC_API_KEY      ${apiKey ? C.ok('已配置（不显示内容）') : '未设置'}`)
console.log(`   VOLC_APP_ID       ${appId ? C.ok(mask(appId)) : C.bad('未设置')}`)
console.log(`   VOLC_ACCESS_TOKEN ${token ? C.ok(mask(token)) : C.bad('未设置')}`)
console.log(`   endpoint          ${C.dim(endpoint)}`)
console.log(`   resourceId        ${C.dim(resourceId)}`)

if (!apiKey && (!appId || !token)) {
  console.log(C.bad('\n缺少凭据，无法继续。'))
  console.log(`
${C.bold('怎么拿：')}
  1. 登录 火山引擎控制台 → 语音技术 → 录音文件识别
  2. 开通「录音文件识别大模型」，创建一个应用
  3. 复制语音 API Key（新版控制台），写进项目根目录的 .env：

       VOLC_API_KEY=你的语音APIKey
       VOLC_RESOURCE_ID=volc.seedasr.auc

  4. 重新执行本脚本
`)
  process.exit(1)
}

// 2. 准备音频
console.log(C.bold('\n2) 准备音频'))
const arg = process.argv[2]
const tmp = join(import.meta.dir, '..', 'data', 'uploads', `_selfcheck_${Date.now()}.wav`)
let audio = arg ? arg : tmp

if (arg) {
  if (!existsSync(arg)) {
    console.log(C.bad(`   文件不存在：${arg}`))
    process.exit(1)
  }
  console.log(`   使用 ${arg}（${(statSync(arg).size / 1024 / 1024).toFixed(1)} MB）`)
} else {
  const r = await run('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', tmp,
  ], 30_000)
  if (r.code !== 0) {
    console.log(C.bad('   生成测试音失败，请确认 ffmpeg 可用'))
    process.exit(1)
  }
  console.log(C.dim('   已生成 3 秒 440Hz 测试音（无语音，只用于验证鉴权是否通过）'))
}

const info = await probe(audio)
console.log(`   时长 ${(info.duration / 1000).toFixed(1)}s`)

// 3. 调用
console.log(C.bold('\n3) 调用火山 ASR'))
const { transcribeWithVolc } = await import('../src/asr')
const t0 = Date.now()
try {
  const res = await transcribeWithVolc(audio, info.duration, (p) => {
    process.stdout.write(`\r   进度 ${String(p).padStart(3)}%`)
  })
  process.stdout.write('\r')
  const ms = Date.now() - t0
  console.log(C.ok(`   调用成功，耗时 ${(ms / 1000).toFixed(1)}s`))
  if (res.warning) console.log(C.warn(`   注意：${res.warning}`))

  if (res.segments.length === 0) {
    console.log(C.warn('   没有识别到文字。'))
    console.log(C.dim('   若用的是测试音，这是正常的（纯音调没有人声），说明鉴权已通过。'))
    console.log(C.dim('   想验证识别质量，请传一段真实音频：bun run scripts/verify-volc-asr.ts 你的音频.wav'))
  } else {
    console.log(C.ok(`   识别出 ${res.segments.length} 条：`))
    for (const s of res.segments.slice(0, 10)) {
      console.log(`     [${(s.start / 1000).toFixed(1)}s → ${(s.end / 1000).toFixed(1)}s] ${s.text}`)
    }
    if (res.segments.length > 10) console.log(C.dim(`     ... 其余 ${res.segments.length - 10} 条`))
  }
  console.log(C.bold(C.ok('\n结论：凭据可用，可以直接在应用里用了。\n')))
} catch (e: any) {
  console.log(C.bad(`   调用失败，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`))
  console.log(C.bad(`   ${e?.message ?? e}\n`))

  const msg = String(e?.message ?? '')
  if (msg.includes('鉴权失败') || msg.includes('55000001') || msg.includes('45000010')) {
    console.log(C.warn('语音 API Key 或旧版 AppID / Access Token 无效；通用 AK/SK 不适用。'))
  } else if (msg.includes('55000002')) {
    console.log(C.warn('资源未开通或 Resource-Id 不匹配。去控制台确认已开通「录音文件识别大模型」；若开通的是标准版，需把 VOLC_RESOURCE_ID 改成对应值。'))
  } else if (msg.includes('55000003') || msg.includes('55000004')) {
    console.log(C.warn('触发并发或频率限制。把 VOLC_CONCURRENCY 调成 1 再试。'))
  } else if (msg.includes('55000005')) {
    console.log(C.warn('账户欠费或额度不足，去控制台看下计费状态。'))
  } else if (msg.includes('超时')) {
    console.log(C.warn('超时。检查网络是否能访问 openspeech.bytedance.com。'))
  }
  console.log()
  process.exit(1)
} finally {
  if (!arg && existsSync(tmp)) {
    try {
      const { unlinkSync } = await import('node:fs')
      unlinkSync(tmp)
    } catch {}
  }
}
