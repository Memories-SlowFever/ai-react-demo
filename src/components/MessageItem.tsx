import { memo, useState } from 'react'
import type { Message } from '../lib/types'
import { Markdown } from './Markdown'
import { ToolCard } from './ToolCard'
import { useChat } from '../store/chat'

function Thinking({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="thinking">
      <div onClick={() => setOpen(!open)} className="thinking-head">
        {streaming ? '🧠 思考中…' : '🧠 已思考'} <span>{open ? '收起' : '展开'}</span>
      </div>
      {open && <div className="thinking-body">{text}</div>}
    </div>
  )
}

function Sources({ sources }: { sources: NonNullable<Message['sources']> }) {
  const [open, setOpen] = useState<number | null>(null)
  return (
    <div className="sources">
      <div className="hint">📚 引用来源</div>
      {sources.map((s, i) => (
        <div key={i} className="source" onClick={() => setOpen(open === i ? null : i)}>
          <div><b>[{i + 1}]</b> {s.docName} · 切片 #{s.chunkIdx} <span className="score">相似度 {(s.score * 100).toFixed(0)}%</span></div>
          {open === i && <blockquote>{s.text}</blockquote>}
        </div>
      ))}
    </div>
  )
}

export const MessageItem = memo(function MessageItem({ m, isLast }: { m: Message; isLast: boolean }) {
  const continueGen = useChat((s) => s.continueGen)
  if (m.role === 'tool') return null // 工具消息留在 API 历史中，结果卡片显示在 assistant 消息内部。
  if (m.role === 'user') return <div className="msg user"><div className="bubble">{m.content}</div></div>
  return (
    <div className="msg assistant">
      <div className="avatar">AI</div>
      <div className="bubble">
        {m.reasoning && <Thinking text={m.reasoning} streaming={!!m.streaming && !m.content} />}
        {m.toolCalls?.map((c) => <ToolCard key={c.id} call={c} />)}
        {m.content && <Markdown text={m.content} />}
        {m.streaming && !m.content && !m.reasoning && <span className="dots">●●●</span>}
        {m.streaming && m.content && <span className="cursor" />}
        {m.sources && !!m.sources.length && <Sources sources={m.sources} />}
        {m.error && (
          <div className="error">
            ⚠️ {m.error}
            {isLast && <button onClick={continueGen}>{m.content ? '继续生成' : '重试'}</button>}
          </div>
        )}
      </div>
    </div>
  )
})
