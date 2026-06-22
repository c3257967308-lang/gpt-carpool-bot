/**
 * Supabase Edge Function - 读取邮箱验证码
 *
 * 使用 Deno 运行时，通过 Deno.connectTls 实现 IMAP 连接
 * 注意：此函数需要通过 Supabase CLI 部署
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// CORS 头配置
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Supabase 配置
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || 'https://ebrzdghrzotwrnkimpzi.supabase.co'
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVicnpkZ2hyem90d3Jua2ltcHppIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIwNDQ3NjQsImV4cCI6MjA5NzYyMDc2NH0.29EyMKsL9TYMVRtlUbwPA3pAaFfsJlf3JvfPQRQVZIo'

/**
 * IMAP 客户端 - 使用 Deno TCP socket 实现
 */
class ImapClient {
  private conn!: Deno.TlsConn
  private buf = ''
  private tag = 0

  /** 连接 IMAP 服务器 */
  async connect(host: string, port: number): Promise<void> {
    this.conn = await Deno.connectTls({ hostname: host, port })
    // 读取服务器欢迎消息
    await this.readLine()
  }

  /** 从缓冲区读取一行 */
  private async readLine(): Promise<string> {
    while (true) {
      const idx = this.buf.indexOf('\r\n')
      if (idx !== -1) {
        const line = this.buf.substring(0, idx)
        this.buf = this.buf.substring(idx + 2)
        return line
      }
      const chunk = new Uint8Array(4096)
      const n = await this.conn.read(chunk)
      if (n === null) throw new Error('IMAP 连接已关闭')
      this.buf += new TextDecoder().decode(chunk.subarray(0, n))
    }
  }

  /** 发送 IMAP 命令并收集所有响应 */
  private async sendCommand(cmd: string): Promise<string[]> {
    const tag = `A${++this.tag}`
    this.conn.write(new TextEncoder().encode(`${tag} ${cmd}\r\n`))
    const responses: string[] = []

    while (true) {
      const line = await this.readLine()
      responses.push(line)
      // 以当前 tag 开头的行表示命令结束
      if (line.startsWith(`${tag} `)) {
        if (!line.startsWith(`${tag} OK`)) {
          throw new Error(`IMAP 命令错误: ${line}`)
        }
        return responses
      }
    }
  }

  /** 登录邮箱 */
  async login(user: string, pass: string): Promise<void> {
    await this.sendCommand(`LOGIN "${user}" "${pass}"`)
  }

  /** 选择收件箱 */
  async select(folder: string = 'INBOX'): Promise<void> {
    await this.sendCommand(`SELECT "${folder}"`)
  }

  /** 搜索未读邮件，返回 UID 列表 */
  async searchUnseen(since: string): Promise<number[]> {
    const res = await this.sendCommand(`SEARCH UNSEEN SINCE ${since}`)
    for (const line of res) {
      if (line.startsWith('* SEARCH')) {
        return line
          .replace('* SEARCH', '')
          .trim()
          .split(/\s+/)
          .map(Number)
          .filter((n) => !isNaN(n))
      }
    }
    return []
  }

  /** 获取邮件内容 */
  async fetch(uid: number): Promise<string> {
    const res = await this.sendCommand(`FETCH ${uid} (BODY.PEEK[])`)
    return res.join('\n')
  }

  /** 登出并关闭连接 */
  async logout(): Promise<void> {
    try {
      this.conn.write(new TextEncoder().encode(`A${++this.tag} LOGOUT\r\n`))
      this.conn.close()
    } catch (_) {
      // 忽略关闭时的错误
    }
  }
}

/**
 * 从邮件文本中提取验证码
 */
function extractCode(text: string): string | null {
  if (!text) return null

  // 去掉 HTML 标签和 HTML 实体
  let clean = text.replace(/<[^>]+>/g, ' ')
  clean = clean.replace(/&nbsp;/g, ' ')
  clean = clean.replace(/&amp;/g, '&')
  clean = clean.replace(/&lt;/g, '<')
  clean = clean.replace(/&gt;/g, '>')
  clean = clean.replace(/\s+/g, ' ')

  // 多种验证码匹配模式
  const patterns = [
    /(?:verification\s*code|验证码|code|确认码|安全码)[\s:：是]*([0-9]{4,8})/i,
    /([0-9]{4,8})[\s]*(?:is\s*your|为你的|是你的|是您的)/i,
    /(?:enter|input|type)[\s:]*([0-9]{4,8})/i,
    /(?:^|[\s\[\(（\-:>])([0-9]{6})(?:[\s\]\)）\-:,.<]|$)/,
    /(?:^|[\s\[\(（\-:>])([0-9]{4,8})(?:[\s\]\)）\-:,.<]|$)/,
  ]

  for (const p of patterns) {
    const m = clean.match(p)
    if (m) return m[1]
  }
  return null
}

/**
 * 从 FETCH 响应中提取邮件正文
 */
function extractBody(fetchResponse: string): string {
  // 查找 BODY[] 部分的起始和结束
  const bodyStart = fetchResponse.indexOf('BODY[]')
  if (bodyStart === -1) return ''

  // 找到左括号后的内容
  const contentStart = fetchResponse.indexOf('{', bodyStart)
  if (contentStart === -1) return ''

  // 提取 {数字} 中的长度
  const closeBrace = fetchResponse.indexOf('}', contentStart)
  if (closeBrace === -1) return ''

  const lenStr = fetchResponse.substring(contentStart + 1, closeBrace)
  const len = parseInt(lenStr, 10)
  if (isNaN(len)) return ''

  // 跳过 } 后的换行
  const bodyContent = fetchResponse.substring(closeBrace + 2, closeBrace + 2 + len)
  return bodyContent
}

/**
 * 从 Supabase 查询邮箱 IMAP 配置
 */
async function getAccount(emailAddr: string) {
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

  const { data, error } = await supabase
    .from('email_accounts')
    .select('*')
    .ilike('email', emailAddr)
    .limit(1)

  if (error) throw new Error(`Supabase 查询失败: ${error.message}`)
  if (!data || data.length === 0) return null
  return data[0]
}

/**
 * 主处理逻辑：连接 IMAP 读取验证码
 */
async function fetchVerificationCode(account: Record<string, unknown>): Promise<{ success: boolean; code?: string; error?: string }> {
  const host = account.imap_host as string
  const port = (account.imap_port as number) || 993
  const user = (account.imap_user as string) || (account.email as string)
  const password = account.imap_pass as string

  if (!host || !password) {
    return { success: false, error: '邮箱 IMAP 配置不完整' }
  }

  const imap = new ImapClient()

  try {
    // 连接 IMAP 服务器
    await imap.connect(host, port)
    await imap.login(user, password)
    await imap.select('INBOX')

    // 计算日期范围，逐步扩大搜索范围
    const now = new Date()
    const ranges = [30, 120, 1440] // 30分钟、2小时、24小时

    let uids: number[] = []
    for (const minutes of ranges) {
      const since = new Date(now.getTime() - minutes * 60 * 1000)
      const dateStr = since
        .toISOString()
        .split('T')[0]
        .replace(/-/g, '-')
        // IMAP 日期格式: DD-Mon-YYYY
        .split('-')
        .reverse()
        .join('-')

      // 转换为 IMAP 日期格式
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
      const d = since.getDate()
      const m = months[since.getMonth()]
      const y = since.getFullYear()
      const imapDate = `${String(d).padStart(2, '0')}-${m}-${y}`

      uids = await imap.searchUnseen(imapDate)
      if (uids.length > 0) break
    }

    if (uids.length === 0) {
      await imap.logout()
      return { success: false, error: '未找到最近的邮件，请先触发验证码发送' }
    }

    // 最多检查最近 5 封邮件
    const latest = uids.length > 5 ? uids.slice(-5) : uids

    for (const uid of latest.reverse()) {
      try {
        const raw = await imap.fetch(uid)
        const body = extractBody(raw)

        // 提取验证码
        const code = extractCode(body)
        if (code) {
          await imap.logout()
          return { success: true, code }
        }
      } catch (e) {
        console.error(`读取邮件 ${uid} 时出错:`, e)
        continue
      }
    }

    await imap.logout()
    return { success: false, error: '在最近的邮件中未找到验证码' }
  } catch (e) {
    try { await imap.logout() } catch (_) {}
    return { success: false, error: `邮箱连接失败: ${(e as Error).message}` }
  }
}

/**
 * Edge Function 入口
 */
Deno.serve(async (req: Request) => {
  // 处理 CORS 预检请求
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // 只接受 GET 请求
    if (req.method !== 'GET') {
      return new Response(
        JSON.stringify({ success: false, error: '仅支持 GET 请求' }),
        { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // 获取 email 参数
    const url = new URL(req.url)
    const emailAddr = (url.searchParams.get('email') || '').trim().toLowerCase()

    if (!emailAddr) {
      return new Response(
        JSON.stringify({ success: false, error: '缺少 email 参数' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // 从 Supabase 查询邮箱配置
    const account = await getAccount(emailAddr)
    if (!account) {
      return new Response(
        JSON.stringify({ success: false, error: `未找到邮箱 ${emailAddr} 的配置` }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // 连接 IMAP 读取验证码
    const result = await fetchVerificationCode(account)
    return new Response(
      JSON.stringify(result),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (e) {
    return new Response(
      JSON.stringify({ success: false, error: `服务器错误: ${(e as Error).message}` }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
