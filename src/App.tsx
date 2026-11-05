import { useState } from 'react'
import { ChatPage } from './pages/ChatPage'
import { KnowledgePage } from './pages/KnowledgePage'
import { FlowPage } from './pages/FlowPage'
import { SettingsPage } from './pages/SettingsPage'
import { useChat } from './store/chat'

const TABS = [
  ['chat', '💬 对话'], ['kb', '📚 知识库'], ['flow', '🕸 工作流'], ['settings', '⚙️ 设置'],
] as const

export default function App() {
  // 页面通过 hidden 保持挂载，切换标签不会卸载正在输出的对话或重置画布状态。
  const [tab, setTab] = useState<(typeof TABS)[number][0]>('chat')
  const mock = useChat((s) => s.settings.mock || !s.settings.apiKey)
  return (
    <div className="app">
      <nav className="topbar">
        <b>AI React Demo</b>
        {TABS.map(([k, label]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{label}</button>)}
        <span className="badge">{mock ? 'Mock 模型' : 'DeepSeek 实时'}</span>
      </nav>
      <main>
        {/* 用 display 切换而非卸载，保持流式生成与画布状态 */}
        <div hidden={tab !== 'chat'} className="fill"><ChatPage /></div>
        <div hidden={tab !== 'kb'} className="fill"><KnowledgePage /></div>
        <div hidden={tab !== 'flow'} className="fill"><FlowPage /></div>
        <div hidden={tab !== 'settings'} className="fill"><SettingsPage /></div>
      </main>
    </div>
  )
}
