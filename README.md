# AI React Demo

面向「AI / 大模型 / Agent 前端」岗位的 React + TS 学习 Demo，一个项目覆盖 5 个阶段。

| 阶段 | 内容 | 位置 |
| --- | --- | --- |
| 1 流式对话 | Fetch + ReadableStream 解析 SSE、AbortController 停止、半行缓冲、重试、断流「继续生成」、Markdown/GFM + 代码高亮/复制/行号 + Mermaid、多会话 + 草稿 + localStorage（Zustand persist） | `src/lib/stream.ts` `src/store/chat.ts` `src/components/Markdown.tsx` |
| 2 Function Calling | JSON Schema 工具定义、tool_calls 增量参数拼接、Agent 多轮循环、工具结果卡片（时间/天气/订单表）、写操作确认表单、思考过程折叠、上下文截断 | `src/lib/tools.ts` `src/components/ToolCard.tsx` |
| 3 RAG 前端 | 分片上传 + 进度条、文档列表、切片预览、TF-IDF 检索（TopK/阈值可调）、回答引用溯源 | `src/store/kb.ts` `src/pages/KnowledgePage.tsx` |
| 4 工作流画布 | React Flow：拖拽节点、连线、节点配置表单、按链路运行并实时显示节点状态 | `src/pages/FlowPage.tsx` |
| 5 Next.js 代理 | App Router：服务端组件读 env、`/api/chat` 路由代理 SSE，Key 不出服务器 | `next-proxy/` |

## 运行

```bash
npm install
npm run dev          # 默认使用 Mock 模型，无需 Key
```

接真实模型：「设置」页关闭 Mock，填 DeepSeek Key（`https://api.deepseek.com` / `deepseek-chat`）。
纯前端直连会暴露 Key，仅限本地演示；正式使用走阶段 5：

```bash
cd next-proxy && cp .env.example .env.local   # 填 DEEPSEEK_API_KEY
npm install && npm run dev
```

## 说明与取舍
- RAG 检索在浏览器内用 TF-IDF 实现，便于离线演示；生产应换 embedding + 向量库（Dify / LibreChat 等后端）。
- 工作流运行为线性链路（每节点取第一条出边），分支/并行是后续扩展点。
- 阶段 5 提供的是代理示例，没有把整个 Vite 应用逐页迁移到 Next。
