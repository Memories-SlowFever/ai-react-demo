# AI React Demo

面向「AI / 大模型 / Agent 前端」岗位的 React + TS 学习 Demo，一个项目覆盖 5 个阶段。

| 阶段 | 内容 | 位置 |
| --- | --- | --- |
| 1 流式对话 | Fetch + ReadableStream 解析 SSE、AbortController 停止、半行缓冲、重试、断流「继续生成」、Markdown/GFM + 代码高亮/复制/行号 + Mermaid、多会话 + 草稿 + localStorage（Zustand persist） | `src/lib/stream.ts` `src/store/chat.ts` `src/components/Markdown.tsx` |
| 2 Function Calling | JSON Schema 工具定义、tool_calls 增量参数拼接、Agent 多轮循环、工具结果卡片（时间/天气/订单表）、写操作确认表单、思考过程折叠、上下文截断 | `src/lib/tools.ts` `src/components/ToolCard.tsx` |
| 3 RAG 前端 | 文本类文件导入（txt/md/csv/json）、分片与预览、TF-IDF 检索（Top K/阈值可调）、候选分数与筛选原因、回答引用溯源；文档数据保存在 IndexedDB，并迁移旧版 localStorage 数据 | `src/store/kb.ts` `src/lib/indexedDbStorage.ts` `src/pages/KnowledgePage.tsx` |
| 4 工作流画布 | React Flow：拖拽节点、连线、节点配置、运行状态；运行前检查开始/结束节点、断路、不可达节点、循环和多出边；支持 JSON 导入/导出及本地保存 | `src/pages/FlowPage.tsx` |
| 5 Next.js 代理 | App Router：服务端组件读 env、`/api/chat` 路由代理 SSE，Key 不出服务器 | `next-proxy/` |

## 运行

```bash
npm install
npm run dev          # 默认使用 Mock 模型，无需 Key
```

生产构建与本地预览：

```bash
npm run build
npm run preview
```

接真实模型：「设置」页关闭 Mock，填 DeepSeek Key（`https://api.deepseek.com` / `deepseek-chat`）。
纯前端直连会暴露 Key，仅限本地演示；正式使用走阶段 5：

```bash
cd next-proxy && cp .env.example .env.local   # 填 DEEPSEEK_API_KEY
npm install && npm run dev
```

## 说明与取舍
- RAG 检索在浏览器内用 TF-IDF 实现，便于离线演示；生产应换 embedding + 向量库（Dify / LibreChat 等后端）。
- RAG 文档与工作流数据保存在当前浏览器中，不会自动跨浏览器或设备同步；清理浏览器站点数据会删除本地数据。
- 工作流校验会拦截不支持的循环、不可达节点和多出边等结构；当前运行为线性链路（每节点取第一条出边），分支/并行执行是后续扩展点。
- 阶段 5 提供的是代理示例，没有把整个 Vite 应用逐页迁移到 Next。
- 纯前端直连模型时，API Key 会暴露在浏览器中；GitHub Pages 是静态托管，不能安全保存服务端密钥。需要真实密钥时应使用 `next-proxy/` 或其他受控后端。

## GitHub Pages 部署

仓库已配置 GitHub Actions：向 `main` 推送提交后，会自动安装依赖、运行 `npm run build` 并发布 `dist/` 到 GitHub Pages，无需手动生成或提交 `dist/`。部署流程见 `.github/workflows/deploy.yml`。首次启用时，需在仓库 **Settings → Pages → Build and deployment** 中选择 **GitHub Actions**。

部署完成后访问：<https://memories-slowfever.github.io/ai-react-demo/>。若页面仍显示旧资源，可强制刷新浏览器缓存。
