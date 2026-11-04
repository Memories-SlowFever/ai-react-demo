import { useEffect, useRef } from 'react'
import { useChat } from '../store/chat'
import { MessageItem } from '../components/MessageItem'

export function ChatPage() {
  const { sessions, order, currentId, running, newChat, switchChat, deleteChat, setDraft, send, stop } = useChat()
  const session = sessions[currentId]
  const busy = !!running[currentId]
  const listRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  // 只有用户停留在底部时才自动滚动，向上翻看历史时不抢滚动条
  useEffect(() => {
    const el = listRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [session.messages])
  useEffect(() => { stick.current = true }, [currentId])

  // 组件卸载（切到别的页签）不终止生成：流跑在 store 里；真正需要 abort 的是删除会话 / 点停止
  const submit = () => { stick.current = true; send(session.draft) }
  const msgs = session.messages

  return (
    <div className="chat-layout">
      <aside className="sidebar">
        <button className="primary" onClick={newChat}>＋ 新对话</button>
        {order.map((id) => (
          <div key={id} className={'session' + (id === currentId ? ' active' : '')} onClick={() => switchChat(id)}>
            <span>{running[id] ? '⏳ ' : ''}{sessions[id].title}</span>
            <button className="x" onClick={(e) => { e.stopPropagation(); deleteChat(id) }}>×</button>
          </div>
        ))}
      </aside>
      <section className="chat">
        <div className="messages" ref={listRef} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40 }}>
          {!msgs.length && (
            <div className="empty">
              <h2>AI React Demo</h2>
              <p>试试：「现在几点」「北京天气」「查询已发货订单」「创建一个工单」</p>
              <p>或在「知识库」页上传文档后提问，回答会附带引用来源。</p>
            </div>
          )}
          {msgs.map((m, i) => <MessageItem key={m.id} m={m} isLast={i === msgs.length - 1} />)}
        </div>
        <div className="composer">
          <textarea
            value={session.draft}
            placeholder="输入消息，Enter 发送，Shift+Enter 换行"
            rows={2}
            onChange={(e) => setDraft(currentId, e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit() } }}
          />
          {busy ? <button className="danger" onClick={() => stop()}>■ 停止</button> : <button className="primary" disabled={!session.draft.trim()} onClick={submit}>发送</button>}
        </div>
      </section>
    </div>
  )
}
