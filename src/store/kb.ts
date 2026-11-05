import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { indexedDbStorage } from '../lib/indexedDbStorage'
import type { Source } from '../lib/types'

export interface Chunk { idx: number; text: string }
export interface Doc {
  id: string
  name: string
  size: number
  status: 'uploading' | 'parsing' | 'ready' | 'error'
  progress: number
  chunks: Chunk[]
  error?: string
}
export interface KBConfig { enabled: boolean; topK: number; threshold: number; chunkSize: number; selected: string[] | null }
export interface RetrievalCandidate extends Source {
  matchedTerms: string[]
  decision: 'selected' | 'below-threshold' | 'outside-top-k'
}

interface KBState {
  docs: Doc[]
  cfg: KBConfig
  hydrated: boolean
  setHydrated: (value: boolean) => void
  setCfg: (p: Partial<KBConfig>) => void
  upload: (file: File) => Promise<void>
  addText: (name: string, text: string) => void
  remove: (id: string) => void
}

const uid = () => Math.random().toString(36).slice(2, 10)

/** 按段落贪心合并成 ~size 字的切片，超长段落硬切，相邻切片留 1 句 overlap 的效果由段落粒度近似 */
export function splitChunks(text: string, size: number): Chunk[] {
  const paras = text.split(/\n{2,}|(?<=[。！？!?])\s*/).map((p) => p.trim()).filter(Boolean)
  const out: string[] = []
  let cur = ''
  for (const p of paras) {
    if (cur && (cur + p).length > size) {
      out.push(cur)
      cur = ''
    }
    cur += (cur ? '\n' : '') + p
    while (cur.length > size * 1.5) {
      out.push(cur.slice(0, size))
      cur = cur.slice(size)
    }
  }
  if (cur) out.push(cur)
  return out.map((t, idx) => ({ idx, text: t }))
}

// 中文 bigram + 英文单词，足够演示检索效果（真实场景换成 embedding 向量检索）
const tokenize = (s: string) => {
  const t: string[] = []
  const lower = s.toLowerCase()
  for (const w of lower.match(/[a-z0-9_]+/g) ?? []) t.push(w)
  for (const seg of lower.match(/[一-龥]+/g) ?? []) {
    if (seg.length === 1) t.push(seg)
    for (let i = 0; i < seg.length - 1; i++) t.push(seg.slice(i, i + 2))
  }
  return t
}

/** TF-IDF 候选解释：保留被阈值或 Top K 排除的结果，供检索调试使用。 */
export function inspectRetrieval(query: string, docs: Doc[], cfg: KBConfig): RetrievalCandidate[] {
  const pool = docs
    .filter((d) => d.status === 'ready' && (!cfg.selected || cfg.selected.includes(d.id)))
    .flatMap((d) => d.chunks.map((c) => ({ d, c, toks: tokenize(c.text) })))
  if (!pool.length) return []
  const df = new Map<string, number>()
  for (const p of pool) for (const w of new Set(p.toks)) df.set(w, (df.get(w) ?? 0) + 1)
  const idf = (w: string) => Math.log(1 + pool.length / (df.get(w) ?? 1))
  const vec = (toks: string[]) => {
    const m = new Map<string, number>()
    for (const w of toks) m.set(w, (m.get(w) ?? 0) + idf(w))
    return m
  }
  const q = vec(tokenize(query))
  const norm = (m: Map<string, number>) => Math.sqrt([...m.values()].reduce((a, b) => a + b * b, 0)) || 1
  const qn = norm(q)
  const ranked = pool
    .map(({ d, c, toks }) => {
      const v = vec(toks)
      let dot = 0
      for (const [w, x] of q) dot += x * (v.get(w) ?? 0)
      const matchedTerms = [...q.keys()].filter((w) => v.has(w)).sort()
      return { docId: d.id, docName: d.name, chunkIdx: c.idx, text: c.text, score: dot / (qn * norm(v)), matchedTerms }
    })
    .sort((a, b) => b.score - a.score || a.docName.localeCompare(b.docName) || a.chunkIdx - b.chunkIdx)
  const eligible = ranked.filter((candidate) => candidate.score >= cfg.threshold)
  const selected = new Set(eligible.slice(0, cfg.topK).map((candidate) => `${candidate.docId}:${candidate.chunkIdx}`))
  return ranked.map((candidate) => ({
    ...candidate,
    decision: candidate.score < cfg.threshold
      ? 'below-threshold'
      : selected.has(`${candidate.docId}:${candidate.chunkIdx}`) ? 'selected' : 'outside-top-k',
  }))
}

/** TF-IDF 余弦相似度 → threshold + topK。 */
export function retrieve(query: string, docs: Doc[], cfg: KBConfig): Source[] {
  return inspectRetrieval(query, docs, cfg)
    .filter((candidate) => candidate.decision === 'selected')
    .map(({ matchedTerms: _matchedTerms, decision: _decision, ...source }) => source)
}

const SAMPLE = `React 18 引入了并发渲染（Concurrent Rendering），核心是可中断的渲染过程。

useTransition 可以把状态更新标记为非紧急更新，让输入等紧急交互优先响应。useDeferredValue 用于延迟某个值的更新，常用于搜索联想列表。

Zustand 是一个轻量的 React 状态管理库，没有 Provider，通过 hook 直接订阅 store 的切片。在 AI 对话应用中，流式更新频繁，使用 selector 精确订阅可以避免整个消息列表重渲染。

流式输出可以使用 fetch 配合 ReadableStream。通过 response.body.getReader() 逐块读取，使用 TextDecoder 解码，并按换行拆分 SSE 事件。取消请求使用 AbortController，组件卸载时必须 abort 并 releaseLock，否则会造成内存泄漏。

RAG（检索增强生成）流程：文档解析、切片、向量化、写入向量库；提问时检索 topK 相似切片，注入 prompt，并在回答中展示引用来源。相似度阈值用于过滤低相关内容。`

export const useKB = create<KBState>()(
  persist(
    (set, get) => {
      const patch = (id: string, p: Partial<Doc>) => set((s) => ({ docs: s.docs.map((d) => (d.id === id ? { ...d, ...p } : d)) }))
      return {
        docs: [],
        cfg: { enabled: true, topK: 3, threshold: 0.1, chunkSize: 200, selected: null },
        hydrated: false,
        setHydrated: (hydrated) => set({ hydrated }),
        setCfg: (p) => set((s) => ({ cfg: { ...s.cfg, ...p } })),
        addText: (name, text) =>
          set((s) => ({ docs: [...s.docs, { id: uid(), name, size: text.length, status: 'ready', progress: 100, chunks: splitChunks(text, s.cfg.chunkSize) }] })),
        remove: (id) => set((s) => ({ docs: s.docs.filter((d) => d.id !== id) })),
        /** 分片上传：File.slice 每片 64KB，逐片「发送」（这里模拟网络延迟）并更新进度 */
        upload: async (file) => {
          const id = uid()
          set((s) => ({ docs: [...s.docs, { id, name: file.name, size: file.size, status: 'uploading', progress: 0, chunks: [] }] }))
          const PART = 64 * 1024
          const parts: Blob[] = []
          for (let off = 0; off < file.size || off === 0; off += PART) {
            parts.push(file.slice(off, off + PART))
            await new Promise((r) => setTimeout(r, 150))
            patch(id, { progress: Math.min(100, Math.round((off + PART) / Math.max(file.size, 1) * 100)) })
            if (off + PART >= file.size) break
          }
          patch(id, { status: 'parsing', progress: 100 })
          await new Promise((r) => setTimeout(r, 400))
          if (!/\.(txt|md|markdown|json|csv|log)$/i.test(file.name) && !file.type.startsWith('text/')) {
            patch(id, { status: 'error', error: '演示版仅支持文本类文件（txt / md / csv / json）；PDF/Docx 需后端解析' })
            return
          }
          const text = await new Blob(parts).text()
          patch(id, { status: 'ready', chunks: splitChunks(text, get().cfg.chunkSize) })
        },
      }
    },
    {
      name: 'ai-react-demo:kb',
      storage: createJSONStorage(() => indexedDbStorage),
      partialize: (state) => ({ docs: state.docs, cfg: state.cfg }),
      onRehydrateStorage: () => (state) => state?.setHydrated(true),
      merge: (p, cur) => {
        const s = { ...cur, ...(p as Partial<KBState>) }
        s.docs = s.docs.map((d) => (d.status === 'uploading' || d.status === 'parsing' ? { ...d, status: 'error' as const, error: '上传中断' } : d))
        return s
      },
    },
  ),
)

export const SAMPLE_DOC = { name: 'react-ai-notes.md', text: SAMPLE }
