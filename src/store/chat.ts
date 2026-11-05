/**
 * 对话领域状态：保存会话、设置和逐条消息，并协调网络流、工具确认与知识库检索。
 * 页面通过 Zustand actions 发起操作；run() 将 streamChat 的事件落入指定会话，
 * 因而即使用户切换到别的会话，原会话的流式消息仍能继续更新。
 * 可恢复的数据持久化到 localStorage；运行中的 AbortController 不参与持久化。
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ApiMessage, Message, Session, Settings, ToolCall } from '../lib/types'
import { isAbort, streamChat } from '../lib/stream'
import { confirmTools, runTool, safeParse, waitConfirm, resolveConfirm } from '../lib/tools'
import { retrieve, useKB } from './kb'

const uid = () => Math.random().toString(36).slice(2, 10)

// 默认配置让项目开箱即走 Mock；真实模型参数可在设置页修改并持久化。
export const defaultSettings: Settings = {
  baseUrl: 'https://api.deepseek.com',
  apiKey: '',
  model: 'deepseek-chat',
  mock: true,
  systemPrompt: '你是一个乐于助人的 AI 助手，回答使用 Markdown。',
  maxContextMessages: 20,
  enableTools: true,
}

const newSession = (): Session => ({ id: uid(), title: '新对话', messages: [], draft: '', updatedAt: Date.now() })

interface ChatState {
  sessions: Record<string, Session>
  order: string[]
  currentId: string
  settings: Settings
  /** 正在生成的会话 -> AbortController（不持久化，切会话时流不会乱） */
  running: Record<string, AbortController>

  newChat: () => void
  switchChat: (id: string) => void
  deleteChat: (id: string) => void
  setDraft: (id: string, draft: string) => void
  updateSettings: (p: Partial<Settings>) => void
  send: (text: string) => Promise<void>
  continueGen: () => Promise<void>
  stop: (id?: string) => void
  confirmTool: (callId: string, values: Record<string, any> | null) => void
}

const first = newSession()

export const useChat = create<ChatState>()(
  persist(
    (set, get) => {
      // 这些局部更新器集中处理不可变更新，保证流式增量只替换对应会话/消息。
      const patchSession = (id: string, fn: (s: Session) => Session) =>
        set((st) => (st.sessions[id] ? { sessions: { ...st.sessions, [id]: fn(st.sessions[id]) } } : st))
      const patchMsg = (sid: string, mid: string, fn: (m: Message) => Message) =>
        patchSession(sid, (s) => ({ ...s, messages: s.messages.map((m) => (m.id === mid ? fn(m) : m)) }))
      const pushMsg = (sid: string, m: Message) =>
        patchSession(sid, (s) => ({ ...s, messages: [...s.messages, m], updatedAt: Date.now() }))

      /**
       * 将 UI 消息转换成模型 API 格式：system prompt、可选的本轮检索资料、历史消息。
       * 空 assistant 占位不进入上下文；截断后位于开头的 tool 结果也要丢弃，
       * 因为模型协议要求 tool 结果必须对应前面的 assistant tool_calls。
       */
      const buildApi = (sid: string, extraSystem?: string): ApiMessage[] => {
        const { sessions, settings } = get()
        let hist = sessions[sid].messages.filter((m) => !(m.role === 'assistant' && !m.content && !m.toolCalls?.length))
        // 先限制上下文长度，再去掉孤立 tool 消息，避免违反模型工具协议。
        hist = hist.slice(-settings.maxContextMessages)
        while (hist[0]?.role === 'tool') hist = hist.slice(1)
        const api: ApiMessage[] = [{ role: 'system', content: settings.systemPrompt }]
        if (extraSystem) api.push({ role: 'system', content: extraSystem })
        for (const m of hist) {
          if (m.role === 'assistant' && m.toolCalls?.length)
            api.push({
              role: 'assistant',
              content: m.content,
              tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })),
            })
          else api.push({ role: m.role, content: m.content, tool_call_id: m.toolCallId })
        }
        return api
      }

      /**
       * 驱动一次完整生成：追加 assistant 占位消息并消费流事件；若模型请求工具，
       * 执行并把 tool 结果写回历史，再发下一轮请求，最多往返五轮。
       * AbortController 绑定 sid 而不是当前页面，因此切换会话不会串流；
       * 无论正常结束、失败还是取消，finally 都会清理 running 标记。
       */
      const run = async (sid: string, extraSystem?: string, sources?: Message['sources']) => {
        // AbortController 按会话保存，因此切换会话不影响另一条正在生成的流。
        const ctrl = new AbortController()
        set((st) => ({ running: { ...st.running, [sid]: ctrl } }))
        try {
          // 每轮模型可以继续请求工具；设置上限避免异常模型响应导致无限循环。
          for (let round = 0; round < 5; round++) {
            const mid = uid()
            pushMsg(sid, { id: mid, role: 'assistant', content: '', streaming: true, createdAt: Date.now(), sources: round === 0 ? sources : undefined })
            let calls: ToolCall[] = []
            try {
              for await (const ev of streamChat(get().settings, buildApi(sid, extraSystem), ctrl.signal)) {
                if (ev.type === 'content') patchMsg(sid, mid, (m) => ({ ...m, content: m.content + ev.text }))
                else if (ev.type === 'reasoning') patchMsg(sid, mid, (m) => ({ ...m, reasoning: (m.reasoning ?? '') + ev.text }))
                else {
                  calls = ev.calls.map((c) => ({ ...c, status: 'running' as const }))
                  patchMsg(sid, mid, (m) => ({ ...m, toolCalls: calls }))
                }
              }
            } catch (e) {
              // 失败保留已收到的部分回答；取消不展示为错误，便于用户区分主动停止。
              if (isAbort(e)) patchMsg(sid, mid, (m) => ({ ...m, streaming: false }))
              else patchMsg(sid, mid, (m) => ({ ...m, streaming: false, error: (e as Error).message || '请求失败' }))
              return
            }
            patchMsg(sid, mid, (m) => ({ ...m, streaming: false }))
            if (!calls.length) return

            const setCall = (id: string, p: Partial<ToolCall>) =>
              patchMsg(sid, mid, (m) => ({ ...m, toolCalls: m.toolCalls?.map((c) => (c.id === id ? { ...c, ...p } : c)) }))

            // 按模型返回顺序执行工具；写操作会暂停在确认 Promise，直到用户确认或取消。
            for (const c of calls) {
              let args = safeParse(c.arguments)
              let result: unknown
              if (confirmTools.has(c.name)) {
                setCall(c.id, { status: 'awaiting-confirm' })
                // 确认弹窗与生成流程通过 callId 配对；停止时 signal 分支让生成流程退出等待。
                const v = await Promise.race([
                  waitConfirm(c.id),
                  new Promise<null>((r) => ctrl.signal.addEventListener('abort', () => r(null))),
                ])
                if (v) args = v
                result = v ? runTool(c.name, args) : { cancelled: true }
                setCall(c.id, { status: v ? 'done' : 'rejected', result: JSON.stringify(result) })
              } else {
                result = runTool(c.name, args)
                await new Promise((r) => setTimeout(r, 400)) // 让「执行中」状态可见
                setCall(c.id, { status: 'done', result: JSON.stringify(result) })
              }
              pushMsg(sid, { id: uid(), role: 'tool', content: JSON.stringify(result), toolCallId: c.id, createdAt: Date.now() })
            }
            if (ctrl.signal.aborted) return
          }
        } finally {
          set((st) => {
            const { [sid]: _, ...rest } = st.running
            return { running: rest }
          })
        }
      }

      return {
        sessions: { [first.id]: first },
        order: [first.id],
        currentId: first.id,
        settings: defaultSettings,
        running: {},

        newChat: () => {
          const s = newSession()
          set((st) => ({ sessions: { ...st.sessions, [s.id]: s }, order: [s.id, ...st.order], currentId: s.id }))
        },
        switchChat: (id) => set({ currentId: id }),
        deleteChat: (id) => {
          get().stop(id)
          set((st) => {
            const { [id]: _, ...rest } = st.sessions
            let order = st.order.filter((x) => x !== id)
            if (!order.length) {
              const s = newSession()
              return { sessions: { [s.id]: s }, order: [s.id], currentId: s.id }
            }
            return { sessions: rest, order, currentId: st.currentId === id ? order[0] : st.currentId }
          })
        },
        setDraft: (id, draft) => patchSession(id, (s) => ({ ...s, draft })),
        updateSettings: (p) => set((st) => ({ settings: { ...st.settings, ...p } })),

        /** 发送用户消息；先落盘用户输入，再做可选检索，最后启动该会话的 Agent 循环。 */
        send: async (text) => {
          const sid = get().currentId
          if (get().running[sid] || !text.trim()) return
          pushMsg(sid, { id: uid(), role: 'user', content: text, createdAt: Date.now() })
          patchSession(sid, (s) => ({ ...s, draft: '', title: s.title === '新对话' ? text.slice(0, 20) : s.title }))

          // RAG：命中知识库则把切片注入 system，并把来源挂到回答上
          let extra: string | undefined
          let sources
          // 检索结果只加入本次请求的 system 上下文，并单独附在回答上用于引用展示。
          const kb = useKB.getState()
          if (kb.cfg.enabled && kb.docs.some((d) => d.status === 'ready')) {
            sources = retrieve(text, kb.docs, kb.cfg)
            if (sources.length)
              extra = '【知识库资料】请优先依据以下资料回答，并用 [n] 标注引用：\n' + sources.map((s, i) => `[${i + 1}] ${s.text}`).join('\n')
          }
          await run(sid, extra, sources)
        },

        /**
         * 断流恢复：有部分回答时把“继续”作为新用户指令保留上下文；
         * 若失败前没有任何文本，则移除空 assistant 占位并直接重试。
         */
        continueGen: async () => {
          const sid = get().currentId
          const msgs = get().sessions[sid].messages
          const lastMsg = msgs[msgs.length - 1]
          if (lastMsg?.error) patchMsg(sid, lastMsg.id, (m) => ({ ...m, error: undefined }))
          if (lastMsg?.content) {
            pushMsg(sid, { id: uid(), role: 'user', content: '请从你中断的地方继续，不要重复已输出的内容。', createdAt: Date.now() })
          } else {
            patchSession(sid, (s) => ({ ...s, messages: s.messages.slice(0, -1) })) // 空回复直接重试
          }
          await run(sid)
        },

        stop: (id) => {
          const sid = id ?? get().currentId
          get().running[sid]?.abort()
        },
        confirmTool: (callId, values) => resolveConfirm(callId, values),
      }
    },
    {
      name: 'ai-react-demo:chat',
      // running 中含 AbortController，不能序列化；仅持久化用户可恢复的业务状态。
      partialize: (st) => ({ sessions: st.sessions, order: st.order, currentId: st.currentId, settings: st.settings }),
      // 刷新页面时丢掉遗留的 streaming / running 状态
      merge: (persisted, cur) => {
        const p = persisted as Partial<ChatState> | undefined
        if (!p?.sessions) return cur
        // 刷新意味着旧请求已不存在：清除流式标记，并将中断中的工具调用标成错误。
        for (const s of Object.values(p.sessions))
          s.messages = s.messages.map((m) => ({
            ...m,
            streaming: false,
            toolCalls: m.toolCalls?.map((c) => (c.status === 'running' || c.status === 'awaiting-confirm' ? { ...c, status: 'error' as const } : c)),
          }))
        return { ...cur, ...p, settings: { ...cur.settings, ...p.settings } }
      },
    },
  ),
)
