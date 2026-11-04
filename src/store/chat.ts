import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ApiMessage, Message, Session, Settings, ToolCall } from '../lib/types'
import { isAbort, streamChat } from '../lib/stream'
import { confirmTools, runTool, safeParse, waitConfirm, resolveConfirm } from '../lib/tools'
import { retrieve, useKB } from './kb'

const uid = () => Math.random().toString(36).slice(2, 10)

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
      const patchSession = (id: string, fn: (s: Session) => Session) =>
        set((st) => (st.sessions[id] ? { sessions: { ...st.sessions, [id]: fn(st.sessions[id]) } } : st))
      const patchMsg = (sid: string, mid: string, fn: (m: Message) => Message) =>
        patchSession(sid, (s) => ({ ...s, messages: s.messages.map((m) => (m.id === mid ? fn(m) : m)) }))
      const pushMsg = (sid: string, m: Message) =>
        patchSession(sid, (s) => ({ ...s, messages: [...s.messages, m], updatedAt: Date.now() }))

      /** 上下文管理：system + 截断后的历史（保证 tool 消息前面一定有对应 assistant） */
      const buildApi = (sid: string, extraSystem?: string): ApiMessage[] => {
        const { sessions, settings } = get()
        let hist = sessions[sid].messages.filter((m) => !(m.role === 'assistant' && !m.content && !m.toolCalls?.length))
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

      /** Agent 循环：模型 → tool_calls → 执行 → 带结果再问模型，直到没有工具调用（最多 5 轮） */
      const run = async (sid: string, extraSystem?: string, sources?: Message['sources']) => {
        const ctrl = new AbortController()
        set((st) => ({ running: { ...st.running, [sid]: ctrl } }))
        try {
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
              if (isAbort(e)) patchMsg(sid, mid, (m) => ({ ...m, streaming: false }))
              else patchMsg(sid, mid, (m) => ({ ...m, streaming: false, error: (e as Error).message || '请求失败' }))
              return
            }
            patchMsg(sid, mid, (m) => ({ ...m, streaming: false }))
            if (!calls.length) return

            const setCall = (id: string, p: Partial<ToolCall>) =>
              patchMsg(sid, mid, (m) => ({ ...m, toolCalls: m.toolCalls?.map((c) => (c.id === id ? { ...c, ...p } : c)) }))

            for (const c of calls) {
              let args = safeParse(c.arguments)
              let result: unknown
              if (confirmTools.has(c.name)) {
                setCall(c.id, { status: 'awaiting-confirm' })
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

        send: async (text) => {
          const sid = get().currentId
          if (get().running[sid] || !text.trim()) return
          pushMsg(sid, { id: uid(), role: 'user', content: text, createdAt: Date.now() })
          patchSession(sid, (s) => ({ ...s, draft: '', title: s.title === '新对话' ? text.slice(0, 20) : s.title }))

          // RAG：命中知识库则把切片注入 system，并把来源挂到回答上
          let extra: string | undefined
          let sources
          const kb = useKB.getState()
          if (kb.cfg.enabled && kb.docs.some((d) => d.status === 'ready')) {
            sources = retrieve(text, kb.docs, kb.cfg)
            if (sources.length)
              extra = '【知识库资料】请优先依据以下资料回答，并用 [n] 标注引用：\n' + sources.map((s, i) => `[${i + 1}] ${s.text}`).join('\n')
          }
          await run(sid, extra, sources)
        },

        /** 断流恢复：保留已生成内容，让模型接着写 */
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
      partialize: (st) => ({ sessions: st.sessions, order: st.order, currentId: st.currentId, settings: st.settings }),
      // 刷新页面时丢掉遗留的 streaming / running 状态
      merge: (persisted, cur) => {
        const p = persisted as Partial<ChatState> | undefined
        if (!p?.sessions) return cur
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
