/**
 * 获取验证码 API
 * 接收 email 参数，从 Supabase 读取 IMAP 配置，连接邮箱读取最新验证码
 * Vercel Serverless Function
 */

const { ImapFlow } = require('imapflow');
const { createClient } = require('@supabase/supabase-js');

// Supabase 配置
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ebrzdghrzotwrnkimpzi.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVicnpkZ2hyem90d3Jua2ltcHppIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIwNDQ3NjQsImV4cCI6MjA5NzYyMDc2NH0.29EyMKsL9TYMVRtlUbwPA3pAaFfsJlf3JvfPQRQVZIo';

// ==================== 验证码提取 ====================

/**
 * 从邮件文本中提取验证码
 * @param {string} text - 邮件正文
 * @returns {string|null} 验证码
 */
function extractCode(text) {
  if (!text) return null;

  const patterns = [
    /(?:验证码|verification\s*code|code|确认码|安全码)[\s:：是]*([0-9]{4,8})/i,
    /([0-9]{4,8})[\s]*(?:is\s*your|为你的|是你的|是您的)/i,
    /(?:^|[\s\[\(（\-:>])([0-9]{6})(?:[\s\]\)）\-:,.<]|$)/m,
    /(?:^|[\s\[\(（\-:>])([0-9]{4,8})(?:[\s\]\)）\-:,.<]|$)/m,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) return match[1];
  }
  return null;
}

// ==================== IMAP 读取 ====================

/**
 * 通过 IMAP 读取邮箱最新验证码
 * @param {object} account - 邮箱 IMAP 配置
 * @returns {Promise<{success: boolean, code: string|null, error: string|null}>}
 */
async function fetchVerificationCode(account) {
  if (!account || !account.imap_host || !account.imap_user || !account.imap_pass) {
    return { success: false, code: null, error: '邮箱 IMAP 配置不完整' };
  }

  const client = new ImapFlow({
    host: account.imap_host,
    port: account.imap_port || 993,
    secure: true,
    auth: {
      user: account.imap_user,
      pass: account.imap_pass
    },
    logger: false
  });

  try {
    await client.connect();
    console.log(`IMAP 连接成功: ${account.email}`);

    const lock = await client.getMailboxLock('INBOX');
    let foundCode = null;

    try {
      // 搜索最近 30 分钟的未读邮件
      const since = new Date(Date.now() - 30 * 60 * 1000);
      let messages = await client.search([{ unseen: true }, { since }]);

      // 没有未读邮件则扩大到最近 2 小时
      if (messages.length === 0) {
        console.log('未找到未读邮件，扩大搜索范围...');
        const sinceExtended = new Date(Date.now() - 2 * 60 * 60 * 1000);
        messages = await client.search([{ since: sinceExtended }]);
      }

      if (messages.length === 0) {
        return { success: false, code: null, error: '未找到最近的邮件' };
      }

      // 检查最新的 10 封邮件
      const toCheck = messages.slice(-10);

      for (const uid of toCheck) {
        const message = await client.fetchOne(uid, {
          envelope: true,
          source: true
        }, { uid: true });

        let bodyText = '';
        if (message.source) {
          bodyText = message.source.toString('utf-8')
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/\s+/g, ' ')
            .trim();
        }

        const code = extractCode(bodyText);
        if (code) {
          foundCode = code;
          console.log(`找到验证码: ${code}`);
          break;
        }
      }
    } finally {
      lock.release();
    }

    await client.logout();

    if (foundCode) {
      return { success: true, code: foundCode, error: null };
    } else {
      return { success: false, code: null, error: '未在最近的邮件中找到验证码' };
    }
  } catch (err) {
    console.error(`IMAP 读取失败 (${account.email}):`, err.message);
    try { await client.logout(); } catch (_) {}
    return { success: false, code: null, error: `邮箱连接失败: ${err.message}` };
  }
}

// ==================== 主入口 ====================

module.exports = async (req, res) => {
  // 只允许 GET 请求
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: '只支持 GET 请求' });
  }

  const email = (req.query.email || '').trim().toLowerCase();

  if (!email) {
    return res.status(400).json({ success: false, error: '缺少 email 参数' });
  }

  // 设置 CORS 头（允许前端页面跨域调用）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');

  try {
    // 从 Supabase 查询邮箱 IMAP 配置（不区分大小写）
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    const { data: account, error } = await supabase
      .from('email_accounts')
      .select('*')
      .ilike('email', email)
      .maybeSingle();

    if (error) {
      console.error('查询邮箱配置失败:', error.message);
      return res.status(500).json({ success: false, error: '数据库查询失败' });
    }

    if (!account) {
      return res.status(404).json({ success: false, error: `未找到邮箱 ${email} 的配置` });
    }

    // 读取验证码（设置 20 秒超时）
    const result = await Promise.race([
      fetchVerificationCode(account),
      new Promise((resolve) =>
        setTimeout(() => resolve({ success: false, code: null, error: '读取超时（20秒）' }), 20000)
      )
    ]);

    return res.status(200).json(result);

  } catch (err) {
    console.error('API 错误:', err.message);
    return res.status(500).json({ success: false, error: '服务器内部错误' });
  }
};
