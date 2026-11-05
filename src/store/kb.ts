/**
 * 浏览器端知识库：管理文本文件、切片及检索设置，并将结果用于聊天 RAG。
 * 当前实现是完全本地的演示链路：文本读取 -> 规则切片 -> TF-IDF/余弦打分；
 * 没有文件上传服务器或 embedding 服务，检索结果仍可解释并展示淘汰原因。
 */
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

/**
 * 按段落/句子顺序贪心合并到约 size 字；超长段落按字符硬切兜底。
 * @param text 原始文档文本。
 * @param size 目标切片长度；长度单位是 JavaScript 字符数，不是 token。
 * @returns 从 0 开始编号的切片；为避免重复内容，当前切片之间没有 overlap。
 */
export function splitChunks(text: string, size: number): Chunk[] {
  // 先按自然段/句子分组，避免普通情况从句子中间截断；超长内容再硬切兜底。
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
// 中文用相邻双字词近似分词，英文/数字按连续单词处理，不依赖在线分词服务。
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

/**
 * 为每个可检索切片计算词袋 TF-IDF 向量与查询的余弦相似度。
 * 先按文档状态/选择范围构建语料，再排序并记录未命中的淘汰原因；
 * 返回全部候选是为了让调试页能解释“为什么选中/没选中”，而非只暴露最终 Top K。
 */
export function inspectRetrieval(query: string, docs: Doc[], cfg: KBConfig): RetrievalCandidate[] {
  // 只在当前已就绪且被选中的文档切片上统计词频，避免未选文档影响分数。
  const pool = docs
    .filter((d) => d.status === 'ready' && (!cfg.selected || cfg.selected.includes(d.id)))
    .flatMap((d) => d.chunks.map((c) => ({ d, c, toks: tokenize(c.text) })))
  if (!pool.length) return []
  // IDF 降低常见词权重；随后用余弦相似度排序，便于不同长度切片之间比较。
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
  // 先应用相似度阈值，再从合格候选中取 Top K；其余候选仍返回供调试界面解释。
  const eligible = ranked.filter((candidate) => candidate.score >= cfg.threshold)
  const selected = new Set(eligible.slice(0, cfg.topK).map((candidate) => `${candidate.docId}:${candidate.chunkIdx}`))
  return ranked.map((candidate) => ({
    ...candidate,
    decision: candidate.score < cfg.threshold
      ? 'below-threshold'
      : selected.has(`${candidate.docId}:${candidate.chunkIdx}`) ? 'selected' : 'outside-top-k',
  }))
}

/** 聊天和工作流共用的精简检索入口，只返回通过阈值且位于 Top K 的来源切片。 */
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
          // 上传进度是本地模拟的；浏览器读取文本后分片，当前不向任何服务器传文件。
          const id = uid()
          set((s) => ({ docs: [...s.docs, { id, name: file.name, size: file.size, status: 'uploading', progress: 0, chunks: [] }] }))
          const PART = 64 * 1024
          const parts: Blob[] = []
          // 分片仅用于演示进度，不产生网络请求；最后仍在内存中合并成完整文本。
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
          // 非文本格式不能可靠地在浏览器直接提取正文；此 Demo 明确拒绝而不是存空内容。
          const text = await new Blob(parts).text()
          patch(id, { status: 'ready', chunks: splitChunks(text, get().cfg.chunkSize) })
        },
      }
    },
    {
      name: 'ai-react-demo:kb',
      // 文档正文可能较大，使用 IndexedDB；旧 localStorage 内容由 storage adapter 自动迁移。
      storage: createJSONStorage(() => indexedDbStorage),
      partialize: (state) => ({ docs: state.docs, cfg: state.cfg }),
      onRehydrateStorage: () => (state) => state?.setHydrated(true),
      merge: (p, cur) => {
        // 页面刷新会中断进行中的上传，将遗留状态标记为错误，避免永久显示进度中。
        const s = { ...cur, ...(p as Partial<KBState>) }
        s.docs = s.docs.map((d) => (d.status === 'uploading' || d.status === 'parsing' ? { ...d, status: 'error' as const, error: '上传中断' } : d))
        return s
      },
    },
  ),
)

export const SAMPLE_DOC = { name: 'react-ai-notes.md', text: SAMPLE }
