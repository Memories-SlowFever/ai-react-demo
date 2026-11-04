import { useState } from 'react'
import type { ToolCall } from '../lib/types'
import { safeParse } from '../lib/tools'
import { useChat } from '../store/chat'

const LABEL: Record<string, string> = {
  get_current_time: '🕒 查询时间',
  get_weather: '⛅ 查询天气',
  query_orders: '📦 查询订单',
  create_ticket: '🎫 创建工单',
}

function Result({ name, data }: { name: string; data: any }) {
  if (name === 'get_current_time' && data.local)
    return <div className="clock">{data.local}<small>{data.timezone}</small></div>
  if (name === 'get_weather' && data.city)
    return <div className="weather"><b>{data.temp}°C</b><span>{data.city} · {data.condition} · 湿度 {data.humidity}%</span></div>
  if (name === 'query_orders' && data.rows)
    return (
      <table>
        <thead><tr><th>订单</th><th>商品</th><th>金额</th><th>状态</th></tr></thead>
        <tbody>{data.rows.map((r: any) => <tr key={r.id}><td>{r.id}</td><td>{r.item}</td><td>¥{r.amount}</td><td><span className={'tag ' + r.status}>{r.status}</span></td></tr>)}</tbody>
      </table>
    )
  if (name === 'create_ticket' && data.ticketId)
    return <div className="weather"><b>{data.ticketId}</b><span>{data.title} · {data.priority ?? 'medium'}</span></div>
  return <pre className="json">{JSON.stringify(data, null, 2)}</pre>
}

function ConfirmForm({ call }: { call: ToolCall }) {
  const init = safeParse(call.arguments)
  const [v, setV] = useState({ title: init.title ?? '', priority: init.priority ?? 'medium', detail: init.detail ?? '' })
  const confirm = useChat((s) => s.confirmTool)
  return (
    <form className="confirm" onSubmit={(e) => { e.preventDefault(); confirm(call.id, v) }}>
      <div className="hint">模型请求创建工单，请确认参数：</div>
      <input value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} placeholder="标题" required />
      <select value={v.priority} onChange={(e) => setV({ ...v, priority: e.target.value })}>
        <option value="low">low</option><option value="medium">medium</option><option value="high">high</option>
      </select>
      <textarea value={v.detail} onChange={(e) => setV({ ...v, detail: e.target.value })} rows={2} placeholder="详情" />
      <div className="row">
        <button type="submit" className="primary">确认执行</button>
        <button type="button" onClick={() => confirm(call.id, null)}>拒绝</button>
      </div>
    </form>
  )
}

export function ToolCard({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(false)
  const icon = { running: '⏳', 'awaiting-confirm': '✋', done: '✅', error: '❌', rejected: '🚫' }[call.status]
  return (
    <div className="toolcard">
      <div className="toolcard-head" onClick={() => setOpen(!open)}>
        <span>{LABEL[call.name] ?? call.name}</span>
        <span>{icon} {call.status}</span>
      </div>
      {open && <pre className="json">{`arguments = ${call.arguments}`}</pre>}
      {call.status === 'awaiting-confirm' && <ConfirmForm call={call} />}
      {call.status === 'done' && call.result && <Result name={call.name} data={safeParse(call.result)} />}
    </div>
  )
}
