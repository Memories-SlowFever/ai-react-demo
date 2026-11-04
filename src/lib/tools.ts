/** Function Calling：JSON Schema 入参 + 本地实现（模拟数据） */

export const toolSchemas = [
  {
    type: 'function',
    function: {
      name: 'get_current_time',
      description: '获取指定时区的当前时间',
      parameters: {
        type: 'object',
        properties: { timezone: { type: 'string', description: 'IANA 时区，如 Asia/Shanghai', default: 'Asia/Shanghai' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: '查询城市天气（模拟数据）',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string', description: '城市名，如 北京' } },
        required: ['city'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_orders',
      description: '查询本地模拟订单数据，可按状态过滤',
      parameters: {
        type: 'object',
        properties: { status: { type: 'string', enum: ['all', 'paid', 'shipped', 'refunded'] } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_ticket',
      description: '创建工单。需要用户在表单中确认后才会真正执行',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          priority: { type: 'string', enum: ['low', 'medium', 'high'] },
          detail: { type: 'string' },
        },
        required: ['title'],
      },
    },
  },
] as const

/** 需要用户二次确认（弹表单）的工具 */
export const confirmTools = new Set(['create_ticket'])

const ORDERS = [
  { id: 'A1001', item: 'Mechanical Keyboard', amount: 599, status: 'paid' },
  { id: 'A1002', item: 'USB-C Hub', amount: 239, status: 'shipped' },
  { id: 'A1003', item: '27" Monitor', amount: 1899, status: 'shipped' },
  { id: 'A1004', item: 'Webcam', amount: 329, status: 'refunded' },
  { id: 'A1005', item: 'Desk Lamp', amount: 159, status: 'paid' },
]

export function safeParse(s: string): Record<string, any> {
  try {
    return JSON.parse(s || '{}')
  } catch {
    return {}
  }
}

export function runTool(name: string, args: Record<string, any>): unknown {
  switch (name) {
    case 'get_current_time': {
      const tz = args.timezone || 'Asia/Shanghai'
      try {
        return { timezone: tz, iso: new Date().toISOString(), local: new Date().toLocaleString('zh-CN', { timeZone: tz, hour12: false }) }
      } catch {
        return { error: `无效时区: ${tz}` }
      }
    }
    case 'get_weather': {
      const city = args.city || '北京'
      const seed = [...city].reduce((a, c) => a + c.charCodeAt(0), 0)
      const conds = ['晴', '多云', '小雨', '阴']
      return { city, temp: 8 + (seed % 20), condition: conds[seed % 4], humidity: 30 + (seed % 50) }
    }
    case 'query_orders': {
      const s = args.status || 'all'
      const rows = s === 'all' ? ORDERS : ORDERS.filter((o) => o.status === s)
      return { status: s, total: rows.length, rows }
    }
    case 'create_ticket':
      return { ticketId: 'T-' + Math.floor(1000 + Math.random() * 9000), ...args, createdAt: new Date().toISOString() }
    default:
      return { error: `未知工具: ${name}` }
  }
}

// 用户确认弹窗：执行器 await 一个 Promise，UI 提交表单时 resolve
const pending = new Map<string, (v: Record<string, any> | null) => void>()
export const waitConfirm = (callId: string) => new Promise<Record<string, any> | null>((r) => pending.set(callId, r))
export const resolveConfirm = (callId: string, v: Record<string, any> | null) => {
  pending.get(callId)?.(v)
  pending.delete(callId)
}
