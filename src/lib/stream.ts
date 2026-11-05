/**
 * 对话网络层：将真实兼容接口和本地 Mock 统一成 StreamEvent 异步事件流。
 * 调用方只需消费 content / reasoning / tool_calls，不必了解 SSE 帧格式。
 * 请求取消由调用方传入的 AbortSignal 控制；本层只负责解析、错误分类和
 * 尚未产出内容时的有限重试，不负责更新 UI 或执行工具。
 */
import type { ApiMessage, Settings, StreamEvent } from './types'
import { mockStream } from './mock'
import { toolSchemas } from './tools'

export class HttpError extends Error {
  status: number
  // 保留 HTTP 状态码，让重试逻辑区分限流/服务端错误与客户端错误。
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** 可被 AbortSignal 中断的退避等待，避免用户停止后还要等完重试间隔。 */
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
 * 请求 OpenAI Chat Completions 兼容接口，并将 SSE 转成应用内部事件。
 * 网络 chunk 与 SSE 行没有一一对应关系，所以保留未完整解析的尾行；
 * 工具调用的名称和 arguments 也可能被拆成多帧，按 index 聚合后才发出。
 * HTTP 错误在读取流之前抛出；读取过程中取消或断网则由 reader 向上抛出。
 */
async function* realStream(
  settings: Settings,
  messages: ApiMessage[],
  signal: AbortSignal,
): AsyncGenerator<StreamEvent> {
  // 使用 OpenAI 兼容的 Chat Completions 流式接口；Key 只随请求头发送。
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
      // SSE 数据按行处理；不完整的尾行留在 buffer，等下一次网络读取补齐。
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
        // 同一轮工具调用可能交错到达，按 index 分别拼接名称与 JSON 参数。
        for (const tc of delta.tool_calls ?? []) {
          const c = (calls[tc.index] ??= { id: '', name: '', arguments: '' })
          if (tc.id) c.id = tc.id
          if (tc.function?.name) c.name += tc.function.name
          if (tc.function?.arguments) c.arguments += tc.function.arguments
        }
      }
    }
    // 流结束后才发送完整工具调用，避免上层拿到尚未闭合的 JSON 参数。
  } finally {
    // 不主动 cancel：正常读取已结束，异常/取消时 fetch 的 signal 会中断底层读取。
    reader.releaseLock()
  }
  const list = Object.values(calls)
  if (list.length) yield { type: 'tool_calls', calls: list }
}

/**
 * 对外统一入口。
 * @param settings 决定 Mock/真实请求、模型、地址及工具开关。
 * @param messages 已按模型协议整理好的上下文消息。
 * @param signal 用于停止当前请求及等待中的重试。
 * @param maxRetry 首个事件前最多重试次数，间隔按 500ms 指数增长。
 * @returns 按到达顺序产出内容、思考过程或完整工具调用。
 * 已经产出事件后不再重试，避免重复文本；此时由会话层提供“继续生成”。
 */
export async function* streamChat(
  settings: Settings,
  messages: ApiMessage[],
  signal: AbortSignal,
  maxRetry = 2,
): AsyncGenerator<StreamEvent> {
  // 未启用真实模型或未填写 Key 时走本地 Mock，静态 Demo 无需后端即可体验。
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
