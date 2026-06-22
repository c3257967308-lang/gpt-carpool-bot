/**
 * 获取验证码 API - 简化版
 * 使用 Microsoft Graph API (Outlook) 和 Gmail API 读取邮件
 * 不需要 IMAP，纯 HTTP 请求
 */

// Supabase 配置
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ebrzdghrzotwrnkimpzi.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVicnpkZ2hyem90d3Jua2ltcHppIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIwNDQ3NjQsImV4cCI6MjA5NzYyMDc2NH0.29EyMKsL9TYMVRtlUbwPA3pAaFfsJlf3JvfPQRQVZIo';

// 验证码提取正则
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

// 从 Supabase 查询邮箱配置
async function getAccountFromSupabase(email) {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/email_accounts?email=ilike.${encodeURIComponent(email)}&select=*`, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`
      }
    });
    const data = await res.json();
    return Array.isArray(data) && data.length > 0 ? data[0] : null;
  } catch (e) {
    console.error('Supabase query error:', e.message);
    return null;
  }
}

// 模拟读取验证码（用于测试，不需要真实邮箱密码）
function getMockCode(email) {
  // 生成一个基于邮箱的固定验证码（方便测试）
  const hash = email.split('').reduce((a, b) => a + b.charCodeAt(0), 0);
  const code = String(100000 + (hash % 900000));
  return code;
}

// ==================== 主入口 ====================

module.exports = async (req, res) => {
  // 设置 CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: '只支持 GET 请求' });
  }

  const email = (req.query.email || '').trim().toLowerCase();
  if (!email) {
    return res.status(400).json({ success: false, error: '缺少 email 参数' });
  }

  try {
    // 查询邮箱配置
    const account = await getAccountFromSupabase(email);

    if (!account) {
      return res.status(404).json({ success: false, error: `未找到邮箱 ${email} 的配置` });
    }

    // 检查是否有 IMAP 密码
    if (!account.imap_pass) {
      return res.status(400).json({
        success: false,
        error: '邮箱 IMAP 密码未配置，请联系管理员'
      });
    }

    // TODO: 这里应该调用真实的邮件 API 读取验证码
    // 由于 OAuth 配置复杂，暂时返回模拟验证码用于测试
    // 实际使用时，需要配置 Microsoft Graph API 或 Gmail API 的 OAuth

    // 模拟验证码（测试用）
    const mockCode = getMockCode(email);

    return res.status(200).json({
      success: true,
      code: mockCode,
      note: '当前为测试模式，返回模拟验证码。如需真实验证码，请配置邮箱 OAuth 授权。'
    });

  } catch (err) {
    console.error('API error:', err.message);
    return res.status(500).json({ success: false, error: '服务器内部错误' });
  }
};
