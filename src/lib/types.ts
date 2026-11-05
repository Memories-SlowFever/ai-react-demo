/**
 * 前端领域类型与模型协议类型的边界。
 * Message / ToolCall 面向 UI 和持久化；ApiMessage 是发给兼容模型接口的载荷；
 * StreamEvent 则是网络层向 store 发出的统一增量事件。
 */
export type Role = 'system' | 'user' | 'assistant' | 'tool'

/** UI 展示状态与模型协议分开；arguments 保留原始 JSON 以支持流式拼接。 */
export interface ToolCall {
  id: string
  name: string
  /** 模型流式返回的原始 JSON 字符串（拼接完才能 parse） */
  arguments: string
  status: 'running' | 'awaiting-confirm' | 'done' | 'error' | 'rejected'
  result?: string
}

export interface Source {
  docId: string
  docName: string
  chunkIdx: number
  text: string
  score: number
}

export interface Message {
  id: string
  role: Role
  content: string
  /** 思考过程（reasoning_content），可折叠 */
  reasoning?: string
  toolCalls?: ToolCall[]
  toolCallId?: string
  sources?: Source[]
  error?: string
  streaming?: boolean
  createdAt: number
}

/** 每个会话独立保存消息和输入草稿；顺序由 chat store 单独维护。 */
export interface Session {
  id: string
  title: string
  messages: Message[]
  draft: string
  updatedAt: number
}

export interface Settings {
  baseUrl: string
  apiKey: string
  model: string
  /** 没有 key 时走本地 mock，保证 Demo 开箱可玩 */
  mock: boolean
  systemPrompt: string
  /** 上下文截断：最多携带多少条历史消息 */
  maxContextMessages: number
  enableTools: boolean
}

/** 网络层统一事件，屏蔽真实模型与 Mock 之间的实现差异。 */
export type StreamEvent =
  | { type: 'content'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_calls'; calls: { id: string; name: string; arguments: string }[] }

export interface ApiMessage {
  role: Role
  content: string
  tool_call_id?: string
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
}
