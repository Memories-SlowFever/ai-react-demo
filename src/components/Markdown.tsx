import { memo, useEffect, useId, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { PrismLight as Highlighter } from 'react-syntax-highlighter'
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism'
import ts from 'react-syntax-highlighter/dist/esm/languages/prism/typescript'
import tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx'
import js from 'react-syntax-highlighter/dist/esm/languages/prism/javascript'
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json'
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash'
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python'
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css'
import markup from 'react-syntax-highlighter/dist/esm/languages/prism/markup'

// 轻量版 Prism 只注册项目常见语言，避免把完整语言包都放进首屏。
for (const [n, l] of Object.entries({ ts, typescript: ts, tsx, js, javascript: js, jsx: tsx, json, bash, sh: bash, python, py: python, css, html: markup }))
  Highlighter.registerLanguage(n, l)

function Mermaid({ code }: { code: string }) {
  const id = 'm' + useId().replace(/:/g, '')
  const [svg, setSvg] = useState('')
  const [err, setErr] = useState('')
  // Mermaid 采用动态导入并做短暂防抖，流式代码未完成时不必每个字符都重新解析。
  useEffect(() => {
    let cancelled = false
    // 流式输出过程中图表是不完整的，渲染失败时静默等待下一次更新
    const t = setTimeout(async () => {
      try {
        const mermaid = (await import('mermaid')).default
        mermaid.initialize({ startOnLoad: false, theme: 'dark' })
        const r = await mermaid.render(id, code)
        if (!cancelled) { setSvg(r.svg); setErr('') }
      } catch (e) {
        if (!cancelled) setErr((e as Error).message)
      }
    }, 300)
    return () => { cancelled = true; clearTimeout(t) }
  }, [code, id])
  if (svg) return <div className="mermaid" dangerouslySetInnerHTML={{ __html: svg }} />
  return <pre className="code-fallback">{err ? '图表渲染中…\n' : ''}{code}</pre>
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false)
  if (lang === 'mermaid') return <Mermaid code={code} />
  return (
    <div className="codeblock">
      <div className="codeblock-head">
        <span>{lang || 'text'}</span>
        <button
          onClick={() => {
            navigator.clipboard.writeText(code)
            setCopied(true)
            setTimeout(() => setCopied(false), 1200)
          }}
        >
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <Highlighter language={lang || 'text'} style={vscDarkPlus} showLineNumbers customStyle={{ margin: 0, background: 'transparent', fontSize: 13 }}>
        {code}
      </Highlighter>
    </div>
  )
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  // 自定义代码、链接渲染：行内代码保持轻量，代码块交给 Prism，外链新标签打开。
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // react-markdown v9+：块级代码块的 <pre> 里包着 <code>，行内 code 没有 language- 前缀且不含换行
          code({ className, children }) {
            const code = String(children).replace(/\n$/, '')
            const lang = /language-(\w+)/.exec(className ?? '')?.[1]
            if (!lang && !code.includes('\n')) return <code className="inline">{children}</code>
            return <CodeBlock lang={lang ?? ''} code={code} />
          },
          pre: ({ children }) => <>{children}</>,
          a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})
