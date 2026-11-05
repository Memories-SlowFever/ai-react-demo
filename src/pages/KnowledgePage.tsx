import { useRef, useState } from 'react'
import { inspectRetrieval, SAMPLE_DOC, useKB } from '../store/kb'

export function KnowledgePage() {
  const { docs, cfg, hydrated, setCfg, upload, addText, remove } = useKB()
  const [openId, setOpenId] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const candidates = q.trim() && hydrated ? inspectRetrieval(q, docs, cfg) : []
  const selectedCount = candidates.filter((r) => r.decision === 'selected').length
  const open = docs.find((d) => d.id === openId)

  return (
    <div className="page kb">
      <div className="panel">
        <h3>知识库</h3>
        <div className="row">
          <button className="primary" disabled={!hydrated} onClick={() => input.current?.click()}>上传文档</button>
          <button disabled={!hydrated} onClick={() => addText(SAMPLE_DOC.name, SAMPLE_DOC.text)}>加载示例文档</button>
          <input ref={input} type="file" multiple hidden accept=".txt,.md,.markdown,.csv,.json,.log" onChange={(e) => { [...(e.target.files ?? [])].forEach(upload); e.target.value = '' }} />
        </div>
        {!hydrated && <div className="hint">正在读取本地知识库…</div>}
        <label className="switch"><input type="checkbox" checked={cfg.enabled} disabled={!hydrated} onChange={(e) => setCfg({ enabled: e.target.checked })} /> 对话时启用知识库检索</label>
        <div className="doclist">
          {!docs.length && <div className="hint">暂无文档。拖一个 .md / .txt 进来，或点「加载示例文档」。</div>}
          {docs.map((d) => (
            <div key={d.id} className={'doc' + (d.id === openId ? ' active' : '')} onClick={() => setOpenId(d.id)}>
              <div className="row between">
                <span>
                  <input type="checkbox" disabled={d.status !== 'ready'} checked={!cfg.selected || cfg.selected.includes(d.id)}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => {
                      const all = docs.map((x) => x.id)
                      const cur = cfg.selected ?? all
                      setCfg({ selected: e.target.checked ? [...cur, d.id] : cur.filter((x) => x !== d.id) })
                    }} /> {d.name}
                </span>
                <button className="x" onClick={(e) => { e.stopPropagation(); remove(d.id) }}>×</button>
              </div>
              <div className="hint">{(d.size / 1024).toFixed(1)} KB · {{ uploading: '上传中', parsing: '解析中', ready: `${d.chunks.length} 个切片`, error: d.error }[d.status]}</div>
              {(d.status === 'uploading' || d.status === 'parsing') && <div className="bar"><i style={{ width: d.progress + '%' }} /></div>}
            </div>
          ))}
        </div>
        <h4>检索参数</h4>
        <label>Top K：{cfg.topK}<input type="range" min={1} max={8} value={cfg.topK} onChange={(e) => setCfg({ topK: +e.target.value })} /></label>
        <label>相似度阈值：{cfg.threshold.toFixed(2)}<input type="range" min={0} max={0.8} step={0.01} value={cfg.threshold} onChange={(e) => setCfg({ threshold: +e.target.value })} /></label>
        <label>切片大小（仅对新文档生效）：{cfg.chunkSize}<input type="range" min={80} max={600} step={20} value={cfg.chunkSize} onChange={(e) => setCfg({ chunkSize: +e.target.value })} /></label>
      </div>
      <div className="panel grow">
        <h3>检索测试</h3>
        <input className="full" placeholder="输入问题，预览命中的切片与相似度…" value={q} onChange={(e) => setQ(e.target.value)} />
        {q && hydrated && <div className="hint">{candidates.length} 个候选 · {selectedCount} 个送入回答 · 显示前 50 个</div>}
        {q && hydrated && !selectedCount && <div className="hint">没有切片达到当前阈值；可调低阈值或检查文档选择。</div>}
        {candidates.slice(0, 50).map((r, i) => (
          <div key={`${r.docId}:${r.chunkIdx}`} className={`source retrieval-result ${r.decision}`}>
            <div className="retrieval-head">
              <b>#{i + 1} {r.docName} · 切片 #{r.chunkIdx}</b>
              <span className="score">{(r.score * 100).toFixed(1)}%</span>
            </div>
            <div className="hint">{{ selected: '将送入模型', 'below-threshold': '低于阈值', 'outside-top-k': '超出 Top K' }[r.decision]}</div>
            {r.matchedTerms.length > 0 && <div className="hint">匹配词：{r.matchedTerms.join('、')}</div>}
            <blockquote>{r.text}</blockquote>
          </div>
        ))}
        {open && (
          <>
            <h3>切片预览：{open.name}</h3>
            {open.chunks.map((c) => <div key={c.idx} className="chunk"><span>#{c.idx}</span>{c.text}</div>)}
          </>
        )}
      </div>
    </div>
  )
}
