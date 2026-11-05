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
const FLOW_FORMAT = 'ai-react-demo-flow'
const FLOW_VERSION = 1
const MAX_FLOW_FILE_SIZE = 1024 * 1024
const KINDS = new Set<Kind>(['start', 'llm', 'kb', 'tool', 'end'])
const TOOLS = new Set(['get_current_time', 'get_weather', 'query_orders'])

function parseWorkflow(value: unknown): { nodes: FNode[]; edges: Edge[] } {
  if (!value || typeof value !== 'object') throw new Error('文件内容必须是 JSON 对象')
  const data = value as Record<string, unknown>
  if (data.format !== FLOW_FORMAT || data.version !== FLOW_VERSION) throw new Error('不支持的工作流文件格式或版本')
  if (!Array.isArray(data.nodes) || !Array.isArray(data.edges)) throw new Error('工作流缺少节点或连线数据')
  if (data.nodes.length < 1 || data.nodes.length > 200 || data.edges.length > 1000) throw new Error('节点或连线数量超出限制')

  const ids = new Set<string>()
  const nodes = data.nodes.map((raw): FNode => {
    if (!raw || typeof raw !== 'object') throw new Error('节点格式无效')
    const node = raw as Record<string, unknown>
    const config = node.data as Record<string, unknown> | null
    const position = node.position as Record<string, unknown> | null
    if (typeof node.id !== 'string' || !node.id.trim() || ids.has(node.id)) throw new Error('节点 ID 缺失或重复')
    if (!position || typeof position.x !== 'number' || !Number.isFinite(position.x) || typeof position.y !== 'number' || !Number.isFinite(position.y)) {
      throw new Error(`节点「${node.id}」坐标无效`)
    }
    if (!config || typeof config !== 'object' || !KINDS.has(config.kind as Kind) || typeof config.label !== 'string' || !config.label.trim()) {
      throw new Error(`节点「${node.id}」配置无效`)
    }
    if (config.kind === 'llm' && config.prompt !== undefined && typeof config.prompt !== 'string') throw new Error(`节点「${node.id}」Prompt 无效`)
    if (config.kind === 'tool') {
      if (typeof config.tool !== 'string' || !TOOLS.has(config.tool)) throw new Error(`节点「${node.id}」工具类型无效`)
      if (config.args !== undefined && typeof config.args !== 'string') throw new Error(`节点「${node.id}」参数模板无效`)
    }
    ids.add(node.id)
    const cleanData: NData = {
      kind: config.kind as Kind,
      label: config.label.slice(0, 100),
      ...(typeof config.prompt === 'string' ? { prompt: config.prompt.slice(0, 10000) } : {}),
      ...(typeof config.tool === 'string' ? { tool: config.tool } : {}),
      ...(typeof config.args === 'string' ? { args: config.args.slice(0, 10000) } : {}),
      status: 'idle',
    }
    return { id: node.id, type: 'agent', position: { x: position.x, y: position.y }, data: cleanData }
  })

  const edgeIds = new Set<string>()
  const edges = data.edges.map((raw): Edge => {
    if (!raw || typeof raw !== 'object') throw new Error('连线格式无效')
    const edge = raw as Record<string, unknown>
    if (typeof edge.id !== 'string' || !edge.id.trim() || edgeIds.has(edge.id)) throw new Error('连线 ID 缺失或重复')
    if (typeof edge.source !== 'string' || typeof edge.target !== 'string' || !ids.has(edge.source) || !ids.has(edge.target)) {
      throw new Error(`连线「${edge.id}」引用了不存在的节点`)
    }
    edgeIds.add(edge.id)
    return { id: edge.id, source: edge.source, target: edge.target, animated: true }
  })
  return { nodes, edges }
}

function validateWorkflow(nodes: FNode[], edges: Edge[]): string[] {
  const errors: string[] = []
  const starts = nodes.filter((n) => n.data.kind === 'start')
  const ends = nodes.filter((n) => n.data.kind === 'end')
  if (starts.length !== 1) errors.push(`需要且只能有一个开始节点（当前 ${starts.length} 个）`)
  if (ends.length !== 1) errors.push(`需要且只能有一个结束节点（当前 ${ends.length} 个）`)

  const byId = new Map(nodes.map((n) => [n.id, n]))
  const outgoing = new Map<string, Edge[]>()
  const incoming = new Map<string, Edge[]>()
  for (const edge of edges) {
    if (!byId.has(edge.source) || !byId.has(edge.target)) {
      errors.push(`连线「${edge.id}」引用了不存在的节点`)
      continue
    }
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge])
    incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge])
  }

  for (const node of nodes) {
    if ((outgoing.get(node.id)?.length ?? 0) > 1) errors.push(`节点「${node.data.label}」有多条出边；当前执行器只支持单一路径`)
    if (node.data.kind === 'start' && (incoming.get(node.id)?.length ?? 0) > 0) errors.push('开始节点不能有入边')
    if (node.data.kind === 'end' && (outgoing.get(node.id)?.length ?? 0) > 0) errors.push(`结束节点「${node.data.label}」不能有出边`)
  }

  if (starts.length === 1) {
    const visited = new Set<string>()
    let current: FNode | undefined = starts[0]
    while (current) {
      if (visited.has(current.id)) {
        errors.push(`检测到循环：执行路径回到了「${current.data.label}」`)
        break
      }
      visited.add(current.id)
      if (current.data.kind === 'end') break
      const nextEdge = outgoing.get(current.id)?.[0]
      if (!nextEdge) {
        errors.push(`执行路径在「${current.data.label}」中断，无法到达结束节点`)
        break
      }
      current = byId.get(nextEdge.target)
    }
    const unreachable = nodes.filter((n) => !visited.has(n.id))
    if (unreachable.length) errors.push(`存在从开始节点不可达的节点：${unreachable.map((n) => n.data.label).join('、')}`)
    if (ends.length === 1 && !visited.has(ends[0].id)) errors.push('执行路径无法到达结束节点')
  }

  return [...new Set(errors)]
}

function load(): { nodes: FNode[]; edges: Edge[] } {
  try {
    const v = JSON.parse(localStorage.getItem(STORE_KEY) ?? '')
    if (v.nodes && v.edges) return {
      nodes: v.nodes.map((n: FNode) => ({ ...n, data: { ...n.data, status: 'idle', output: undefined } })),
      edges: v.edges,
    }
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
  const fileInput = useRef<HTMLInputElement>(null)
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

  const exportWorkflow = () => {
    const payload = { format: FLOW_FORMAT, version: FLOW_VERSION, exportedAt: new Date().toISOString(), nodes, edges }
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url
    link.download = 'ai-react-workflow.json'
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    setLog('工作流已导出')
  }

  const importWorkflow = async (file?: File) => {
    if (!file) return
    if (file.size > MAX_FLOW_FILE_SIZE) {
      setLog('导入失败：文件不能超过 1 MB')
      return
    }
    try {
      const parsed = parseWorkflow(JSON.parse(await file.text()))
      setNodes(parsed.nodes)
      setEdges(parsed.edges)
      setSelId(null)
      setLog(`已导入 ${parsed.nodes.length} 个节点和 ${parsed.edges.length} 条连线；点击「保存」写入本地`)
    } catch (e) {
      setLog(`导入失败：${(e as Error).message}`)
    }
  }

  /** 沿连线从 start 依次执行（简化：每个节点只取第一条出边，即线性链路） */
  const run = async () => {
    const errors = validateWorkflow(nodes, edges)
    if (errors.length) {
      setLog(`运行前校验未通过：\n${errors.map((e) => `• ${e}`).join('\n')}`)
      return
    }
    const start = nodes.find((n) => n.data.kind === 'start')
    if (!start) return
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
        <div className="row flow-file-actions">
          <button onClick={exportWorkflow}>导出 JSON</button>
          <button onClick={() => fileInput.current?.click()}>导入 JSON</button>
          <input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={(e) => { void importWorkflow(e.target.files?.[0]); e.target.value = '' }} />
        </div>
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
