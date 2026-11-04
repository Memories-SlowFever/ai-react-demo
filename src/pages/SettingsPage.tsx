import { useChat } from '../store/chat'

export function SettingsPage() {
  const { settings: s, updateSettings: u } = useChat()
  return (
    <div className="page">
      <div className="panel grow settings">
        <h3>模型设置</h3>
        <label className="switch"><input type="checkbox" checked={s.mock} onChange={(e) => u({ mock: e.target.checked })} /> 使用本地 Mock 模型（无需 Key，演示用）</label>
        <label>Base URL<input value={s.baseUrl} onChange={(e) => u({ baseUrl: e.target.value })} /></label>
        <label>Model<input value={s.model} onChange={(e) => u({ model: e.target.value })} /></label>
        <label>API Key（仅保存在浏览器 localStorage）<input type="password" value={s.apiKey} onChange={(e) => u({ apiKey: e.target.value })} placeholder="sk-..." /></label>
        <div className="hint warn">⚠️ 纯前端直连会把 Key 暴露在浏览器里，仅限本地/演示。生产环境请用 next-proxy/（阶段 5）在服务端代理。</div>
        <label>System Prompt<textarea rows={3} value={s.systemPrompt} onChange={(e) => u({ systemPrompt: e.target.value })} /></label>
        <label>上下文最多携带消息数：{s.maxContextMessages}<input type="range" min={2} max={50} value={s.maxContextMessages} onChange={(e) => u({ maxContextMessages: +e.target.value })} /></label>
        <label className="switch"><input type="checkbox" checked={s.enableTools} onChange={(e) => u({ enableTools: e.target.checked })} /> 启用工具调用（Function Calling）</label>
      </div>
    </div>
  )
}
