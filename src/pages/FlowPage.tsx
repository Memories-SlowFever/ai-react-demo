import { useCallback, useRef, useState } from 'react'
import {
  ReactFlow, ReactFlowProvider, Background, Controls, MiniMap, Handle, Position, addEdge, useEdgesState, useNodesState, useReactFlow,
  type Connection, type Edge, type Node, type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useChat } from '../store/chat'
import { useKB, retrieve } from '../store/kb'
import { streamChat } from '../lib/stream'
import { runTool, safeParse } from '../lib/tools'

type Kind = 'start' | 'llm' | 'kb' | 'tool' | 'end'
interface NData extends Record<string, unknown> {
  kind: Kind
  label: string
  prompt?: string // llm：支持 {{input}}
  tool?: string
  args?: string // tool：JSON 模板，支持 {{input}}
  status?: 'idle' | 'running' | 'done' | 'error'
  output?: string
}
type FNode = Node<NData>

const META: Record<Kind, { icon: string; title: string }> = {
  start: { icon: '▶️', title: '开始' }, llm: { icon: '🧠', title: 'LLM' }, kb: { icon: '📚', title: '知识库检索' },
  tool: { icon: '🔧', title: '工具' }, end: { icon: '🏁', title: '结束' },
}

function AgentNode({ data, selected }: NodeProps<FNode>) {
  const m = META[data.kind]
  return (
    <div className={`fnode ${data.status ?? 'idle'}${selected ? ' selected' : ''}`}>
      {data.kind !== 'start' && <Handle type="target" position={Position.Left} />}
      <div className="fnode-title">{m.icon} {data.label}</div>
      {data.output && <div className="fnode-out">{data.output.slice(0, 80)}{data.output.length > 80 ? '…' : ''}</div>}
      {data.kind !== 'end' && <Handle type="source" position={Position.Right} />}
    </div>
  )
}
const nodeTypes = { agent: AgentNode }

const initNodes: FNode[] = [
  { id: 'n1', type: 'agent', position: { x: 0, y: 80 }, data: { kind: 'start', label: '开始' } },
  { id: 'n2', type: 'agent', position: { x: 220, y: 80 }, data: { kind: 'kb', label: '检索知识库' } },
  { id: 'n3', type: 'agent', position: { x: 440, y: 80 }, data: { kind: 'llm', label: '总结回答', prompt: '请基于以下内容回答用户问题：\n{{input}}' } },
  { id: 'n4', type: 'agent', position: { x: 660, y: 80 }, data: { kind: 'end', label: '结束' } },
]
const initEdges: Edge[] = [
  { id: 'e1', source: 'n1', target: 'n2' }, { id: 'e2', source: 'n2', target: 'n3' }, { id: 'e3', source: 'n3', target: 'n4' },
]

const STORE_KEY = 'ai-react-demo:flow'
function load(): { nodes: FNode[]; edges: Edge[] } {
  try {
    const v = JSON.parse(localStorage.getItem(STORE_KEY) ?? '')
    if (v.nodes) return { nodes: v.nodes.map((n: FNode) => ({ ...n, data: { ...n.data, status: 'idle', output: undefined } })), edges: v.edges }
  } catch { /* ignore */ }
  return { nodes: initNodes, edges: initEdges }
}

function Canvas() {
  const init = useRef(load()).current
  const [nodes, setNodes, onNodesChange] = useNodesState<FNode>(init.nodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(init.edges)
  const [selId, setSelId] = useState<string | null>(null)
  const [input, setInput] = useState('React 流式输出怎么取消请求？')
  const [log, setLog] = useState('')
  const [running, setRunning] = useState(false)
  const ctrl = useRef<AbortController | null>(null)
  const { screenToFlowPosition } = useReactFlow()
  const sel = nodes.find((n) => n.id === selId)

  const onConnect = useCallback((c: Connection) => setEdges((es) => addEdge({ ...c, animated: true }, es)), [setEdges])
  const patch = (id: string, p: Partial<NData>) => setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...p } } : n)))

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    const kind = e.dataTransfer.getData('application/node-kind') as Kind
    if (!kind) return
    const id = 'n' + Date.now().toString(36)
    const data: NData = { kind, label: META[kind].title, ...(kind === 'llm' ? { prompt: '{{input}}' } : {}), ...(kind === 'tool' ? { tool: 'get_weather', args: '{"city":"{{input}}"}' } : {}) }
    setNodes((ns) => [...ns, { id, type: 'agent', position: screenToFlowPosition({ x: e.clientX, y: e.clientY }), data }])
  }

  const save = () => { localStorage.setItem(STORE_KEY, JSON.stringify({ nodes, edges })); setLog('已保存到 localStorage') }

  /** 沿连线从 start 依次执行（简化：每个节点只取第一条出边，即线性链路） */
  const run = async () => {
    const start = nodes.find((n) => n.data.kind === 'start')
    if (!start) return setLog('缺少「开始」节点')
    setNodes((ns) => ns.map((n) => ({ ...n, data: { ...n.data, status: 'idle', output: undefined } })))
    const c = (ctrl.current = new AbortController())
    setRunning(true); setLog('')
    let cur = input
    let node: FNode | undefined = start
    const visited = new Set<string>()
    try {
      while (node && !visited.has(node.id)) {
        visited.add(node.id)
        const d: NData = node.data
        patch(node.id, { status: 'running' })
        const fill = (t = '') => t.replaceAll('{{input}}', cur)
        if (d.kind === 'kb') {
          const kb = useKB.getState()
          const r = retrieve(cur, kb.docs, kb.cfg)
          cur = r.length ? r.map((s, i) => `[${i + 1}] ${s.text}`).join('\n') + `\n\n问题：${cur}` : cur
          patch(node.id, { output: r.length ? `命中 ${r.length} 个切片` : '未命中，透传输入' })
        } else if (d.kind === 'tool') {
          const out = JSON.stringify(runTool(d.tool ?? '', safeParse(fill(d.args))))
          cur = out
          patch(node.id, { output: out })
        } else if (d.kind === 'llm') {
          let text = ''
          const settings = { ...useChat.getState().settings, enableTools: false }
          for await (const ev of streamChat(settings, [{ role: 'user', content: fill(d.prompt) }], c.signal)) {
            if (ev.type === 'content') { text += ev.text; patch(node.id, { output: text }) }
          }
          cur = text
        } else if (d.kind === 'end') patch(node.id, { output: cur })
        patch(node.id, { status: 'done' })
        const next: Edge | undefined = edges.find((e) => e.source === node!.id)
        node = nodes.find((n) => n.id === next?.target)
      }
      setLog(cur)
    } catch (e) {
      setLog((e as Error).name === 'AbortError' ? '已停止' : '出错：' + (e as Error).message)
      setNodes((ns) => ns.map((n) => (n.data.status === 'running' ? { ...n, data: { ...n.data, status: 'error' } } : n)))
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="flow">
      <aside className="palette">
        <div className="hint">拖拽节点到画布</div>
        {(['llm', 'kb', 'tool', 'end'] as Kind[]).map((k) => (
          <div key={k} className="pitem" draggable onDragStart={(e) => e.dataTransfer.setData('application/node-kind', k)}>{META[k].icon} {META[k].title}</div>
        ))}
        <hr />
        <textarea value={input} onChange={(e) => setInput(e.target.value)} rows={3} placeholder="工作流输入" />
        {running ? <button className="danger" onClick={() => ctrl.current?.abort()}>■ 停止</button> : <button className="primary" onClick={run}>▶ 运行</button>}
        <button onClick={save}>保存</button>
        <button onClick={() => { setNodes(initNodes); setEdges(initEdges); setLog('') }}>重置</button>
        {log && <pre className="flow-log">{log}</pre>}
      </aside>
      <div className="canvas" onDrop={onDrop} onDragOver={(e) => e.preventDefault()}>
        <ReactFlow
          nodes={nodes} edges={edges} nodeTypes={nodeTypes} colorMode="dark" fitView
          onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect}
          onSelectionChange={({ nodes: s }) => setSelId(s[0]?.id ?? null)}
        >
          <Background /><Controls /><MiniMap />
        </ReactFlow>
      </div>
      <aside className="config">
        <h4>节点配置</h4>
        {!sel && <div className="hint">选中一个节点编辑；Backspace 删除节点/连线</div>}
        {sel && (
          <>
            <label>名称<input value={sel.data.label} onChange={(e) => patch(sel.id, { label: e.target.value })} /></label>
            {sel.data.kind === 'llm' && <label>Prompt 模板（{'{{input}}'} = 上游输出）<textarea rows={6} value={sel.data.prompt} onChange={(e) => patch(sel.id, { prompt: e.target.value })} /></label>}
            {sel.data.kind === 'tool' && (
              <>
                <label>工具<select value={sel.data.tool} onChange={(e) => patch(sel.id, { tool: e.target.value })}>
                  <option value="get_current_time">get_current_time</option><option value="get_weather">get_weather</option><option value="query_orders">query_orders</option>
                </select></label>
                <label>参数 JSON<textarea rows={4} value={sel.data.args} onChange={(e) => patch(sel.id, { args: e.target.value })} /></label>
              </>
            )}
            {sel.data.kind === 'kb' && <div className="hint">使用「知识库」页的 TopK / 阈值参数</div>}
            {sel.data.output && <pre className="flow-log">{sel.data.output}</pre>}
          </>
        )}
      </aside>
    </div>
  )
}

export const FlowPage = () => <ReactFlowProvider><Canvas /></ReactFlowProvider>
