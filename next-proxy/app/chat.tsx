'use client'
import { useRef, useState } from 'react'

export default function Chat({ disabled }: { disabled: boolean }) {
  const [q, setQ] = useState('用一句话介绍 React')
  const [out, setOut] = useState('')
  const ctrl = useRef<AbortController | null>(null)

  // 发起新请求前取消旧请求；停止按钮会复用同一个 controller 中断读取。
  async function ask() {
    ctrl.current?.abort()
    const c = (ctrl.current = new AbortController())
    setOut('')
    // 浏览器只请求自己的 /api/chat，没有任何 Key
    const res = await fetch('/api/chat', {
      method: 'POST', signal: c.signal, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: q }] }),
    })
    // 从代理返回的 SSE 流逐行提取增量文本，保留未完整到达的尾行。
    const reader = res.body!.getReader()
    const dec = new TextDecoder()
    let buf = ''
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const lines = buf.split('\n'); buf = lines.pop() ?? ''
        for (const l of lines) {
          if (!l.startsWith('data:') || l.includes('[DONE]')) continue
          try { setOut((o) => o + (JSON.parse(l.slice(5)).choices?.[0]?.delta?.content ?? '')) } catch {}
        }
      }
    } catch (e) { if ((e as Error).name !== 'AbortError') throw e } finally { reader.releaseLock() }
  }

  return (
    <div>
      <input value={q} onChange={(e) => setQ(e.target.value)} style={{ width: '70%' }} />
      <button disabled={disabled} onClick={ask}>发送</button>
      <button onClick={() => ctrl.current?.abort()}>停止</button>
      <pre style={{ whiteSpace: 'pre-wrap' }}>{out}</pre>
    </div>
  )
}
