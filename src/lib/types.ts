export type Role = 'system' | 'user' | 'assistant' | 'tool'

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
