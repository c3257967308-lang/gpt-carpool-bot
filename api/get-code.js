/**
 * 获取验证码 API - 纯 Node.js 内置模块版
 * 使用 tls + 手写 IMAP 协议，不依赖任何第三方库
 * Vercel Serverless Function
 */

const tls = require('tls');
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ebrzdghrzotwrnkimpzi.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVicnpkZ2hyem90d3Jua2ltcHppIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIwNDQ3NjQsImV4cCI6MjA5NzYyMDc2NH0.29EyMKsL9TYMVRtlUbwPA3pAaFfsJlf3JvfPQRQVZIo';

// ==================== IMAP 客户端（纯 Node.js） ====================

class SimpleImap {
  constructor(host, port, user, pass) {
    this.host = host;
    this.port = port || 993;
    this.user = user;
    this.pass = pass;
    this.socket = null;
    this.tag = 0;
    this.data = '';
    this.lines = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('连接超时（15秒）'));
      }, 15000);

      this.socket = tls.connect({ host: this.host, port: this.port, servername: this.host }, () => {
        clearTimeout(timeout);
        // 读取服务器欢迎消息
        this.data = '';
        this.waitLine().then(() => resolve()).catch(reject);
      });

      this.socket.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  waitLine() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('等待响应超时'));
      }, 10000);

      const check = () => {
        const idx = this.data.indexOf('\r\n');
        if (idx !== -1) {
          const line = this.data.substring(0, idx);
          this.data = this.data.substring(idx + 2);
          clearTimeout(timeout);
          resolve(line);
        } else {
          this.socket.once('data', (chunk) => {
            this.data += chunk.toString('utf8');
            check();
          });
        }
      };
      check();
    });
  }

  send(cmd) {
    return new Promise((resolve, reject) => {
      const tag = 'A' + (++this.tag);
      this.socket.write(tag + ' ' + cmd + '\r\n');

      const responses = [];
      const check = () => {
        const idx = this.data.indexOf('\r\n');
        if (idx !== -1) {
          const line = this.data.substring(0, idx);
          this.data = this.data.substring(idx + 2);
          responses.push(line);
          // 检查是否是标签完成的响应
          if (line.startsWith(tag + ' ')) {
            if (line.startsWith(tag + ' OK')) {
              resolve(responses);
            } else {
              reject(new Error('IMAP 命令失败: ' + line));
            }
          } else {
            check();
          }
        } else {
          this.socket.once('data', (chunk) => {
            this.data += chunk.toString('utf8');
            check();
          });
        }
      };
      check();
    });
  }

  async login() {
    const user = this.user || '';
    const pass = this.pass || '';
    await this.send('LOGIN "' + user.replace(/"/g, '\\"') + '" "' + pass.replace(/"/g, '\\"') + '"');
  }

  async searchUnread(sinceDate) {
    const dateStr = sinceDate.toISOString().replace(/T.*$/, '');
    const responses = await this.send('SEARCH UNSEEN SINCE ' + dateStr);
    // 最后一行是 tag OK，倒数第二行是搜索结果
    for (let i = responses.length - 2; i >= 0; i--) {
      const line = responses[i];
      if (line.startsWith('* SEARCH')) {
        const nums = line.replace('* SEARCH', '').trim().split(/\s+/).map(Number).filter(n => !isNaN(n));
        return nums;
      }
    }
    return [];
  }

  async fetchHeaders(uids) {
    const results = [];
    for (const uid of uids) {
      try {
        const responses = await this.send('FETCH ' + uid + ' (BODY[HEADER.FIELDS (FROM SUBJECT DATE)])');
        for (const line of responses) {
          if (line.startsWith('* ')) {
            results.push({ uid, header: line });
          }
        }
      } catch (e) {
        // 跳过失败的
      }
    }
    return results;
  }

  async fetchBody(uid) {
    const responses = await this.send('FETCH ' + uid + ' (BODY.PEEK[TEXT])');
    let body = '';
    for (const line of responses) {
      if (line.startsWith('* ')) {
        // 提取邮件正文
        const match = line.match(/\{(\d+)\}/);
        if (match) {
          // 正文可能在下一行
        }
        body += line + '\n';
      }
    }
    return body;
  }

  async fetchFull(uid) {
    const responses = await this.send('FETCH ' + uid + ' (BODY.PEEK[])');
    let full = '';
    for (const line of responses) {
      if (line.startsWith('* ')) {
        full += line + '\n';
      }
    }
    return full;
  }

  logout() {
    return new Promise((resolve) => {
      try {
        if (this.socket && !this.socket.destroyed) {
          this.socket.write('A' + (++this.tag) + ' LOGOUT\r\n');
          this.socket.end();
        }
      } catch (e) {}
      resolve();
    });
  }
}

// ==================== 验证码提取 ====================

function extractCode(text) {
  if (!text) return null;
  // 去掉 HTML 标签
  const clean = text.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ');
  const patterns = [
    /(?:verification\s*code|验证码|code|确认码|安全码)[\s:：是]*([0-9]{4,8})/i,
    /([0-9]{4,8})[\s]*(?:is\s*your|为你的|是你的|是您的)/i,
    /(?:enter|input|type)[\s:]*([0-9]{4,8})/i,
    /(?:^|[\s\[\(（\-:>])([0-9]{6})(?:[\s\]\)）\-:,.<]|$)/m,
    /(?:^|[\s\[\(（\-:>])([0-9]{4,8})(?:[\s\]\)）\-:,.<]|$)/m,
  ];
  for (const p of patterns) {
    const m = clean.match(p);
    if (m && m[1]) return m[1];
  }
  return null;
}

// ==================== 从 Supabase 查询 ====================

async function getAccount(email) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/email_accounts?email=ilike.${encodeURIComponent(email)}&select=*`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
  });
  const data = await res.json();
  return Array.isArray(data) && data.length > 0 ? data[0] : null;
}

// ==================== 读取验证码 ====================

async function fetchCode(account) {
  if (!account || !account.imap_host || !account.imap_pass) {
    return { success: false, error: '邮箱 IMAP 配置不完整，请联系管理员配置密码' };
  }

  const imap = new SimpleImap(
    account.imap_host,
    account.imap_port || 993,
    account.imap_user || account.email,
    account.imap_pass
  );

  try {
    // 连接并登录
    await imap.connect();
    await imap.login();

    // 搜索最近 30 分钟的未读邮件
    let uids = await imap.searchUnread(new Date(Date.now() - 30 * 60 * 1000));

    // 没找到则扩大到 2 小时
    if (uids.length === 0) {
      uids = await imap.searchUnread(new Date(Date.now() - 2 * 60 * 60 * 1000));
    }

    // 还是没有，搜索所有未读
    if (uids.length === 0) {
      uids = await imap.searchUnread(new Date(Date.now() - 24 * 60 * 60 * 1000));
    }

    if (uids.length === 0) {
      await imap.logout();
      return { success: false, error: '未找到最近的邮件，请先在 ChatGPT 登录页面触发验证码发送' };
    }

    // 取最新的 5 封邮件
    const latest = uids.slice(-5);

    for (const uid of latest.reverse()) {
      try {
        const body = await imap.fetchFull(uid);
        const code = extractCode(body);
        if (code) {
          await imap.logout();
          return { success: true, code: code };
        }
      } catch (e) {
        console.error('读取邮件失败:', uid, e.message);
      }
    }

    await imap.logout();
    return { success: false, error: '在最近的邮件中未找到验证码' };

  } catch (err) {
    try { await imap.logout(); } catch (e) {}
    console.error('IMAP 错误:', err.message);
    return { success: false, error: '邮箱连接失败: ' + err.message };
  }
}

// ==================== 主入口 ====================

module.exports = async (req, res) => {
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
    const account = await getAccount(email);
    if (!account) {
      return res.status(404).json({ success: false, error: '未找到邮箱 ' + email + ' 的配置' });
    }

    // 设置 25 秒超时
    const result = await Promise.race([
      fetchCode(account),
      new Promise((resolve) => setTimeout(() => resolve({ success: false, error: '获取超时（25秒）' }), 25000))
    ]);

    return res.status(200).json(result);
  } catch (err) {
    console.error('API 错误:', err.message);
    return res.status(500).json({ success: false, error: '服务器内部错误: ' + err.message });
  }
};
