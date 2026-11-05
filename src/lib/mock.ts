/**
 * 无服务器演示用模型：通过关键词模拟模型回答和 Function Calling 决策，
 * 再以与真实网络层相同的 StreamEvent 逐段输出。这里不调用外部 API，
 * 因此适合 GitHub Pages 等纯静态部署，但回答内容和工具数据都是预设模拟。
 */
import type { ApiMessage, Settings, StreamEvent } from './types'
import { safeParse } from './tools'

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('Aborted', 'AbortError'))
    const onAbort = () => {
      clearTimeout(t)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort) // 正常结束必须移除监听，否则长流会泄漏
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })

/** 将完整文本切成不等长片段，模拟真实网络逐块返回的体感。 */
async function* typewriter(text: string, signal: AbortSignal, kind: 'content' | 'reasoning' = 'content') {
  // 故意按 2~4 个字符随机切片，模拟网络分片
  for (let i = 0; i < text.length; ) {
    const n = 2 + Math.floor(Math.random() * 3)
    yield { type: kind, text: text.slice(i, i + n) } as StreamEvent
    i += n
    await wait(18, signal)
  }
}

const DEMO_MD = `# Hello 👋

这是**本地 Mock** 模型的回复（未配置 API Key 时自动启用）。支持 GFM：

| 能力 | 状态 |
| --- | --- |
| 流式输出 | ✅ |
| 工具调用 | ✅ |
| RAG 引用 | ✅ |

\`\`\`ts
// 取消请求 + 防内存泄漏
const ctrl = new AbortController()
const res = await fetch(url, { signal: ctrl.signal })
const reader = res.body!.getReader()
try { /* read loop */ } finally { reader.releaseLock() }
\`\`\`

\`\`\`mermaid
graph LR
  A[用户输入] --> B[Fetch Stream]
  B --> C{tool_calls?}
  C -- 是 --> D[执行工具]
  D --> B
  C -- 否 --> E[渲染 Markdown]
\`\`\`

试试问我：**现在几点**、**北京天气**、**查询已发货订单**、**帮我创建一个工单**。`

/**
 * 根据最近的用户问题和已有 tool/system 消息选择 Mock 分支。
 * 优先消费上一轮工具结果，其次按关键词模拟工具选择，再处理 RAG 示例引用，
 * 最后返回普通演示回答；整个生成过程可由 AbortSignal 随时取消。
 */
export async function* mockStream(
  messages: ApiMessage[],
  settings: Settings,
  signal: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const last = messages[messages.length - 1]
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? ''
  await wait(300, signal)

  // 工具结果回传后，Mock 生成面向用户的摘要，而不是重复发起工具调用。
  if (last.role === 'tool') {
    const r = safeParse(last.content)
    yield* typewriter('工具结果已拿到，我来总结一下。', signal, 'reasoning')
    let text = '工具调用完成，结果见上方卡片。'
    if (r.local) text = `当前时间（${r.timezone}）是 **${r.local}**。`
    else if (r.condition) text = `**${r.city}** 今天${r.condition}，气温 ${r.temp}°C，湿度 ${r.humidity}%。`
    else if (r.rows) text = `共查到 **${r.total}** 笔订单（状态：${r.status}），详情见上方表格。`
    else if (r.ticketId) text = `工单 **${r.ticketId}** 已创建：${r.title}（优先级 ${r.priority ?? 'medium'}）。`
    else if (r.cancelled) text = '好的，已取消创建工单。'
    yield* typewriter(text, signal)
    return
  }

  // 用关键词路由模拟模型的 Function Calling 决策，便于无 Key 演示完整调用链。
  if (settings.enableTools) {
    const call = (name: string, args: object): StreamEvent => ({
      type: 'tool_calls',
      calls: [{ id: 'call_' + Math.random().toString(36).slice(2, 8), name, arguments: JSON.stringify(args) }],
    })
    if (/几点|时间|time/i.test(lastUser)) {
      yield* typewriter('用户想知道时间，调用 get_current_time。', signal, 'reasoning')
      yield call('get_current_time', { timezone: 'Asia/Shanghai' })
      return
    }
    if (/天气|weather/i.test(lastUser)) {
      const city = lastUser.match(/(北京|上海|广州|深圳|杭州|成都)/)?.[1] ?? '北京'
      yield* typewriter(`用户想查 ${city} 的天气，调用 get_weather。`, signal, 'reasoning')
      yield call('get_weather', { city })
      return
    }
    if (/订单|order/i.test(lastUser)) {
      const status = /已发货|shipped/.test(lastUser) ? 'shipped' : /退款|refund/.test(lastUser) ? 'refunded' : /已支付|paid/.test(lastUser) ? 'paid' : 'all'
      yield* typewriter('需要查询订单数据，调用 query_orders。', signal, 'reasoning')
      yield call('query_orders', { status })
      return
    }
    if (/工单|ticket/i.test(lastUser)) {
      yield* typewriter('创建工单是写操作，需要用户确认。', signal, 'reasoning')
      yield call('create_ticket', { title: lastUser.slice(0, 30), priority: 'medium', detail: lastUser })
      return
    }
  }

  // RAG 切片由 chat store 注入额外 system 消息，Mock 从中取首条作为示例引用。
  const ctx = messages.find((m) => m.role === 'system' && m.content.includes('【知识库资料】'))
  if (ctx) {
    yield* typewriter('检索到相关资料，基于资料作答并标注引用。', signal, 'reasoning')
    const first = ctx.content.match(/\[1\]\s*([^\n]{0,120})/)?.[1] ?? ''
    yield* typewriter(`根据知识库资料，相关内容如下：\n\n> ${first}… [1]\n\n更多细节请展开下方「引用来源」查看原文切片。`, signal)
    return
  }

  yield* typewriter('这是一个普通对话，不需要工具，直接回答。', signal, 'reasoning')
  yield* typewriter(DEMO_MD, signal)
}
