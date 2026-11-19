import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asrMode, defaultDependencies, transcribe } from '../src/asr-service'
import { AsrError, transcribeWithVolc } from '../src/asr'
import { transcribeWithLocalWhisper } from '../src/asr-local'
import { run } from '../src/ffmpeg'

const originalEnv = { ...process.env }
let work = ''
let server: ReturnType<typeof Bun.serve> | undefined
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'ai-clip-asr-test-'))
  process.env.ASR_PROVIDER = 'auto'
  process.env.ASR_LOCAL_FALLBACK = '0'
  process.env.VOLC_API_KEY = ''
  process.env.VOLC_APP_ID = 'test-only'
  process.env.VOLC_ACCESS_TOKEN = 'test-only'
  process.env.VOLC_RETRY_ATTEMPTS = '1'
  process.env.ASR_CACHE = '0'
})
afterEach(() => {
  server?.stop(true)
  server = undefined
  rmSync(work, { recursive: true, force: true })
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key]
  Object.assign(process.env, originalEnv)
})
const segments = [{ id: 'test-segment', start: 0, end: 500, text: '真实接口结果的测试替身。' }]
function dependencies() {
  const calls = { cloud: 0, local: 0 }
  const deps: typeof defaultDependencies = {
    ...defaultDependencies,
    exists: () => true,
    volcReady: () => true,
    localReady: () => true,
    volc: async () => { calls.cloud++; return { segments } },
    local: async () => { calls.local++; return { segments } },
  }
  return { deps, calls }
}

describe('通道选择与失败处理（隔离测试，不调用真实模型）', () => {
  test('默认火山优先，不调用本地', async () => {
    const { deps, calls } = dependencies()
    expect((await transcribe('audio', 1000, undefined, deps)).source).toBe('volc')
    expect(calls).toEqual({ cloud: 1, local: 0 })
  })
  test('默认未配置火山时不自动使用本地，不读取文本网关', async () => {
    const { deps, calls } = dependencies()
    deps.volcReady = () => false
    process.env.OPENAI_API_KEY = 'test-only'
    expect(asrMode(deps)).toBe('unavailable')
    await expect(transcribe('audio', 1000, undefined, deps)).rejects.toThrow('未配置火山')
    expect(calls.local).toBe(0)
  })
  test('火山失败且兜底关闭时明确失败', async () => {
    const { deps, calls } = dependencies()
    deps.volc = async () => { throw new Error('鉴权失败') }
    await expect(transcribe('audio', 1000, undefined, deps)).rejects.toThrow('鉴权失败')
    expect(calls.local).toBe(0)
  })
  test('显式开启兜底后保留火山失败原因及实际来源', async () => {
    const { deps } = dependencies()
    process.env.ASR_LOCAL_FALLBACK = '1'
    deps.volc = async () => { throw new Error('网络超时') }
    const result = await transcribe('audio', 1000, undefined, deps)
    expect(result.source).toBe('whisper')
    expect(result.fallbackFrom).toBe('volc')
    expect(result.warning).toContain('网络超时')
  })
  test('没有火山凭据时仅显式开启兜底才选择本地', async () => {
    const { deps } = dependencies()
    deps.volcReady = () => false
    process.env.ASR_LOCAL_FALLBACK = '1'
    expect(asrMode(deps)).toBe('whisper')
    expect((await transcribe('audio', 1000, undefined, deps)).source).toBe('whisper')
  })
  test('双通道失败保留两个原因', async () => {
    const { deps } = dependencies()
    process.env.ASR_LOCAL_FALLBACK = '1'
    deps.volc = async () => { throw new Error('云端错误') }
    deps.local = async () => { throw new Error('模型缺失') }
    await expect(transcribe('audio', 1000, undefined, deps)).rejects.toThrow('云端错误；本地兜底失败：模型缺失')
  })
  test('本地不可用时不伪造结果', async () => {
    const { deps } = dependencies()
    process.env.ASR_PROVIDER = 'whisper'
    deps.localReady = () => false
    await expect(transcribe('audio', 1000, undefined, deps)).rejects.toThrow('本地 ASR 不可用')
  })
  test('手动本地模式不调用火山', async () => {
    const { deps, calls } = dependencies()
    process.env.ASR_PROVIDER = 'whisper'
    await transcribe('audio', 1000, undefined, deps)
    expect(calls).toEqual({ cloud: 0, local: 1 })
  })
  test('空结果、无文件、无效时长和旧占位模式均失败', async () => {
    const { deps } = dependencies()
    deps.volc = async () => ({ segments: [] })
    await expect(transcribe('audio', 1000, undefined, deps)).rejects.toThrow('有效语音')
    deps.exists = () => false
    await expect(transcribe('audio', 1000, undefined, deps)).rejects.toThrow('不存在')
    deps.exists = () => true
    await expect(transcribe('audio', NaN, undefined, deps)).rejects.toThrow('时长无效')
    process.env.ASR_PROVIDER = 'local'
    await expect(transcribe('audio', 1000, undefined, deps)).rejects.toThrow('不支持')
  })
})

async function audio(seconds = 1) {
  const file = join(work, 'input.wav')
  const r = await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `anullsrc=r=16000:cl=mono`, '-t', String(seconds), '-c:a', 'pcm_s16le', file])
  expect(r.code).toBe(0)
  return file
}
function endpoint(handler: (request: Request) => Response | Promise<Response>) {
  server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: handler })
  process.env.VOLC_ASR_ENDPOINT = `http://127.0.0.1:${server.port}`
}
function response(code: string, body: unknown = {}, status = 200) {
  return Response.json(body, { status, headers: { 'X-Api-Status-Code': code } })
}

describe('火山协议（本地 HTTP 服务 + 真实 FFmpeg 分片）', () => {
  test('提交轮询、缓存命中与时间戳夹紧', async () => {
    const file = await audio()
    process.env.ASR_CACHE = '1'
    let submits = 0
    endpoint(async req => {
      if (new URL(req.url).pathname === '/submit') {
        submits++
        const body = await req.json() as any
        expect(body.audio.rate).toBe(16000)
        expect(body.request.show_utterances).toBe(true)
        return response('20000000')
      }
      return response('20000000', { result: { utterances: [{ start_time: 0, end_time: 1200, text: '这是协议测试。' }] } })
    })
    const result = await transcribeWithVolc(file, 1000)
    expect(result.segments[0]?.end).toBe(1000)
    expect((await transcribeWithVolc(file, 1000)).fromCache).toBe(true)
    expect(submits).toBe(1)
  })
  test('处理中状态会继续轮询，HTTP 请求超时会结束任务', async () => {
    const file = await audio()
    let queries = 0
    process.env.VOLC_POLL_INTERVAL_MS = '500'
    endpoint(req => {
      if (new URL(req.url).pathname === '/submit') return response('20000000')
      return ++queries === 1 ? response('20000001') : response('20000000', { result: { utterances: [{ start_time: 0, end_time: 500, text: '轮询完成。' }] } })
    })
    expect((await transcribeWithVolc(file, 1000)).segments.length).toBe(1)
    expect(queries).toBe(2)
    server!.stop(true)
    process.env.VOLC_REQUEST_TIMEOUT_MS = '1000'
    endpoint(async () => {
      await Bun.sleep(1500)
      return response('20000000')
    })
    await expect(transcribeWithVolc(file, 1000)).rejects.toThrow('全部 1 个分片均转写失败')
  })
  test('新版 API Key 鉴权优先且使用返回的 task_id 查询', async () => {
    const file = await audio()
    process.env.VOLC_API_KEY = 'test-only-api-key'
    endpoint(req => {
      expect(req.headers.get('X-Api-Key')).toBe('test-only-api-key')
      expect(req.headers.has('X-Api-App-Key')).toBe(false)
      if (new URL(req.url).pathname === '/submit') return response('20000000', {task_id:'returned-task-id'})
      expect(req.headers.get('X-Api-Request-Id')).toBe('returned-task-id')
      return response('20000000', {result:{utterances:[{start_time:0,end_time:500,text:'新版协议。'}]}})
    })
    expect((await transcribeWithVolc(file, 1000)).segments.length).toBe(1)
  })
  test('HTTP 401 / 45000010 保留鉴权原因且不重试', async () => {
    const file = await audio()
    let submits = 0
    process.env.VOLC_RETRY_ATTEMPTS = '3'
    endpoint(() => { submits++; return response('45000010', {}, 401) })
    try {
      await transcribeWithVolc(file, 1000)
      throw new Error('不应成功')
    } catch (e) {
      expect(e).toBeInstanceOf(AsrError)
      expect((e as AsrError).code).toBe('auth')
    }
    expect(submits).toBe(1)
  })
  test('限流重试后获得真实协议结果', async () => {
    const file = await audio()
    let submits = 0
    process.env.VOLC_RETRY_ATTEMPTS = '2'
    process.env.VOLC_RETRY_BASE_MS = '200'
    endpoint(req => {
      if (new URL(req.url).pathname === '/submit') return ++submits === 1 ? response('55000004') : response('20000000')
      return response('20000000', { result: { utterances: [{ start_time: 0, end_time: 500, text: '重试成功。' }] } })
    })
    expect((await transcribeWithVolc(file, 1000)).segments.length).toBe(1)
    expect(submits).toBe(2)
  })
  test('部分分片失败不写成功缓存，重试会补齐，末尾小数秒不丢失', async () => {
    const file = await audio(60.4)
    process.env.VOLC_CHUNK_SECONDS = '60'
    process.env.VOLC_CONCURRENCY = '1'
    process.env.ASR_CACHE = '1'
    let submits = 0
    let failSecond = true
    const chunks = new Map<string, number>()
    endpoint(req => {
      const id = req.headers.get('X-Api-Request-Id')!
      if (new URL(req.url).pathname === '/submit') {
        const index = submits++ % 2
        chunks.set(id, index)
        return failSecond && index === 1 ? response('55000005') : response('20000000')
      }
      return response('20000000', { result: { utterances: [{ start_time: 0, end_time: 300, text: chunks.get(id) === 0 ? '开头内容。' : '结尾内容。' }] } })
    })
    const first = await transcribeWithVolc(file, 60400)
    expect(first.warning).toContain('第 2 片')
    failSecond = false
    const second = await transcribeWithVolc(file, 60400)
    expect(second.fromCache).not.toBe(true)
    expect(second.segments.at(-1)?.start).toBe(60000)
    expect(second.warning).toBeUndefined()
    expect(submits).toBe(4)
  })
})

// 替代 CLI 仅验证各后端命令及 JSON 协议；真实 Whisper 推理另行人工验收。
for (const backend of ['python', 'cpp']) {
  test(`本地 ${backend} 参数、结果单位及分片偏移`, async () => {
    const file = await audio(60.4)
    const cli = join(work, 'test-cli')
    writeFileSync(cli, `#!/usr/bin/env bun
const args = process.argv.slice(2)
const cpp = ${backend === 'cpp'}
const fs = require('node:fs'), path = require('node:path')
const get = flag => args[args.indexOf(flag) + 1]
const out = cpp ? get('-of') + '.json' : path.join(get('--output_dir'), path.basename(args[0], '.wav') + '.json')
if (cpp && (!args.includes('-m') || args.includes('--output_dir'))) process.exit(2)
fs.writeFileSync(out, JSON.stringify(cpp ? {transcription:[{offsets:{from:50,to:250},text:'本地协议验证。'}]} : {segments:[{start:0.05,end:0.25,text:'本地协议验证。'}]}))
`)
    chmodSync(cli, 0o755)
    process.env.LOCAL_WHISPER_BIN = cli
    process.env.LOCAL_WHISPER_BACKEND = backend
    process.env.LOCAL_WHISPER_MODEL = file // 仅测试 cpp 对模型路径的校验
    process.env.LOCAL_WHISPER_CHUNK_SECONDS = '60'
    const result = await transcribeWithLocalWhisper(file, 60400)
    expect(result.segments[0]?.start).toBe(50)
    // 使用不同内容避免相邻文本去重，本例两条相隔约 60 秒，不应被合并。
    expect(result.segments.at(-1)?.start).toBe(60050)
    expect(result.segments.at(-1)?.end).toBe(60250)
  })
}
