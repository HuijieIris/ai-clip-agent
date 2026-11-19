import '../env'
import type { HighlightRun } from '../../../../packages/shared/highlights'
import { SYSTEM } from './prompts'

export interface ModelClient {
  ask<T>(stage: string, task: string, input: unknown, validate: (value: unknown) => T, signal?: AbortSignal): Promise<T>
}
export function modelConfig() {
  return {
    key: process.env.HIGHLIGHT_API_KEY || process.env.OPENAI_API_KEY || '',
    base: (process.env.HIGHLIGHT_BASE_URL || process.env.OPENAI_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, ''),
    model: process.env.HIGHLIGHT_MODEL || process.env.CHAT_MODEL || 'qwen-plus',
  }
}
export function modelReady() { return Boolean(modelConfig().key) }
export function combineSignal(signal: AbortSignal | undefined, timeout = 90_000) {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout)
}
export class ModelOutputError extends Error {}
export function createModelClient(calls: HighlightRun['calls'], maxCalls = 100, options: { config?: typeof modelConfig; system?: string; missingKeyMessage?: string } = {}): ModelClient {
  return {
    async ask<T>(stage: string, task: string, input: unknown, validate: (value: unknown) => T, signal?: AbortSignal): Promise<T> {
      const c = (options.config || modelConfig)()
      if (!c.key) throw new Error(options.missingKeyMessage || '未配置高光文本模型：请设置 HIGHLIGHT_API_KEY（与语音 API Key 不同）')
      let formatError = ''
      for (let attempt = 0; attempt < 2; attempt++) {
        if (calls.length >= maxCalls) throw new Error(`本次分析超过${maxCalls}次模型调用预算；已完成的翻译可复用，请重试高光分析`)
        signal?.throwIfAborted()
        const started = Date.now()
        const audit: HighlightRun['calls'][number] = { stage, model: c.model, elapsedMs: 0, inputTokens: null, outputTokens: null, status: 'processing' }
        calls.push(audit)
        let raw: string
        try {
          const res = await fetch(`${c.base}/chat/completions`, {
            method: 'POST', signal: combineSignal(signal),
            headers: { Authorization: `Bearer ${c.key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: c.model, temperature: 0.2, max_tokens: 8000,
              response_format: { type: 'json_object' },
              ...(c.model === 'qwen-plus' || c.model === 'qwen-flash' ? { enable_thinking: false } : {}),
              messages: [{ role: 'system', content: options.system || SYSTEM }, { role: 'user', content: JSON.stringify({ task, input, ...(formatError ? { repair: `上次输出格式或引用校验失败：${formatError}。重新输出完整合法JSON，不改变原文。` } : {}) }) }],
            }),
          })
          if (!res.ok) throw new Error(`文本模型请求失败（HTTP ${res.status}），请检查模型、凭据、额度和接口地域`)
          const body = await res.json() as any
          audit.inputTokens = typeof body.usage?.prompt_tokens === 'number' ? body.usage.prompt_tokens : null
          audit.outputTokens = typeof body.usage?.completion_tokens === 'number' ? body.usage.completion_tokens : null
          if (body.choices?.[0]?.finish_reason === 'length') throw new Error('模型输出被截断，请减小分段或候选数量')
          raw = body.choices?.[0]?.message?.content
          if (typeof raw !== 'string') throw new Error('模型未返回文本内容')
        } catch(error) {audit.status='error';throw error} finally { audit.elapsedMs = Date.now() - started }
        try {
          const value = validate(JSON.parse(raw))
          audit.status = 'ok'
          return value
        } catch (error) {
          audit.status='error'
          formatError = error instanceof Error ? error.message : '无效JSON'
          audit.validationError=formatError
          if (attempt === 1) throw new ModelOutputError(`${stage} 输出校验失败（已修复一次）：${formatError}`)
        }
      }
      throw new Error('模型没有有效结果')
    },
  }
}
