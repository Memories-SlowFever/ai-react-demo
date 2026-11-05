import Chat from './chat'

export const dynamic = 'force-dynamic' // 每次请求在服务器读 env，不能被静态预渲染

// 服务端组件：在服务器上读取环境变量，只把「是否已配置」传给客户端，Key 本身永不下发
export default function Page() {
  // 只向客户端暴露布尔配置状态，绝不把环境变量中的密钥作为 props 返回。
  const configured = !!process.env.DEEPSEEK_API_KEY
  return (
    <>
      <h2>Next.js App Router · 服务端代理</h2>
      <p>服务端 Key 状态：{configured ? '✅ 已配置' : '❌ 未配置（复制 .env.example 为 .env.local）'}</p>
      <Chat disabled={!configured} />
    </>
  )
}
