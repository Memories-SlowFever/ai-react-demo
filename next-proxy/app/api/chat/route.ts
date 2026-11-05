// 服务端接口代理：注入 Key、限制字段、把上游 SSE 原样透传给浏览器
export const runtime = 'nodejs'

export async function POST(req: Request) {
  // 密钥只从服务端环境变量读取；缺失时明确报错，不退回浏览器直连。
  const key = process.env.DEEPSEEK_API_KEY
  if (!key) return Response.json({ error: 'DEEPSEEK_API_KEY not set' }, { status: 500 })

  // 限制消息数量，并只接受代理实际需要的字段，模型名称由服务端配置控制。
  const { messages, tools } = await req.json()
  if (!Array.isArray(messages) || messages.length > 50) return Response.json({ error: 'bad request' }, { status: 400 })

  const upstream = await fetch(`${process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'}/chat/completions`, {
    method: 'POST',
    // 把浏览器的取消传给上游，避免用户点停止后服务端仍在烧 token
    signal: req.signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    // 只放行白名单字段，model 由服务端决定
    body: JSON.stringify({ model: process.env.DEEPSEEK_MODEL ?? 'deepseek-chat', messages, tools, stream: true }),
  })
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform' },
  })
}
