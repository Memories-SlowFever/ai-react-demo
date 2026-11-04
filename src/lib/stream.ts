import type { ApiMessage, Settings, StreamEvent } from './types'
import { mockStream } from './mock'
import { toolSchemas } from './tools'

export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(t)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })

export const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError'

/**
 * Fetch + ReadableStream 解析 SSE（OpenAI / DeepSeek 兼容协议）
 * 难点：
 *  1. 网络分片不会按行切 → 用 buffer 缓存半行，按 \n 切分
 *  2. 工具调用的 arguments 是增量拼接的 JSON 片段 → 按 index 累加，流结束后才能 parse
 *  3. AbortController 取消后 reader 会抛 AbortError，需要 releaseLock 防泄漏
 */
async function* realStream(
  settings: Settings,
  messages: ApiMessage[],
  signal: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const res = await fetch(`${settings.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` },
    body: JSON.stringify({
      model: settings.model,
      messages,
      stream: true,
      ...(settings.enableTools ? { tools: toolSchemas, tool_choice: 'auto' } : {}),
    }),
  })
  if (!res.ok || !res.body) throw new HttpError(res.status, (await res.text().catch(() => '')) || res.statusText)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const calls: Record<number, { id: string; name: string; arguments: string }> = {}

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? '' // 最后一段可能是半行，留到下一轮
      for (const raw of lines) {
        const line = raw.trim()
        if (!line.startsWith('data:')) continue // 忽略注释 / keep-alive
        const data = line.slice(5).trim()
        if (data === '[DONE]') continue
        let json
        try {
          json = JSON.parse(data)
        } catch {
          continue // 分片损坏的行直接跳过
        }
        const delta = json.choices?.[0]?.delta
        if (!delta) continue
        if (delta.reasoning_content) yield { type: 'reasoning', text: delta.reasoning_content }
        if (delta.content) yield { type: 'content', text: delta.content }
        for (const tc of delta.tool_calls ?? []) {
          const c = (calls[tc.index] ??= { id: '', name: '', arguments: '' })
          if (tc.id) c.id = tc.id
          if (tc.function?.name) c.name += tc.function.name
          if (tc.function?.arguments) c.arguments += tc.function.arguments
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
  const list = Object.values(calls)
  if (list.length) yield { type: 'tool_calls', calls: list }
}

/**
 * 对外统一入口。异常重试：只在「还没收到任何数据」时对 429/5xx/网络错误做指数退避重试，
 * 一旦已经产出内容就不能重试（否则内容重复），交给 UI 的「继续生成」处理断流恢复。
 */
export async function* streamChat(
  settings: Settings,
  messages: ApiMessage[],
  signal: AbortSignal,
  maxRetry = 2,
): AsyncGenerator<StreamEvent> {
  const useMock = settings.mock || !settings.apiKey
  for (let attempt = 0; ; attempt++) {
    let yielded = false
    try {
      const gen = useMock ? mockStream(messages, settings, signal) : realStream(settings, messages, signal)
      for await (const ev of gen) {
        yielded = true
        yield ev
      }
      return
    } catch (e) {
      if (isAbort(e)) throw e
      const retryable = !(e instanceof HttpError) || e.status === 429 || e.status >= 500
      if (yielded || !retryable || attempt >= maxRetry) throw e
      await sleep(500 * 2 ** attempt, signal)
    }
  }
}
