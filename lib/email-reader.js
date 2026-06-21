/**
 * 邮箱验证码读取模块
 * 使用 IMAP 协议通过 imapflow 库读取邮箱中的验证码
 * 支持 Gmail（需应用专用密码）和 Outlook
 */

const { ImapFlow } = require('imapflow');

// ==================== 验证码提取 ====================

/**
 * 从邮件文本中提取验证码
 * 支持多种验证码格式：
 * - 6位纯数字
 * - 带有常见关键词的验证码
 * @param {string} text - 邮件正文文本
 * @returns {string|null} 提取到的验证码，未找到返回 null
 */
function extractCode(text) {
  if (!text) return null;

  // 常见的验证码正则模式（按优先级排序）
  const patterns = [
    // "验证码是 123456" 或 "验证码：123456"
    /(?:验证码|verification\s*code|code|确认码|安全码)[\s:：是]*([0-9]{4,8})/i,
    // "123456 is your code" 或 "your code is 123456"
    /([0-9]{4,8})[\s]*(?:is\s*your|为你的|是你的|是您的)/i,
    // 独立的 6 位数字（前后有空白或特殊字符）
    /(?:^|[\s\[\(（\-:>])([0-9]{6})(?:[\s\]\)）\-:,.<]|$)/m,
    // 4-8 位数字兜底
    /(?:^|[\s\[\(（\-:>])([0-9]{4,8})(?:[\s\]\)）\-:,.<]|$)/m,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }

  return null;
}

// ==================== IMAP 邮件读取 ====================

/**
 * 通过 IMAP 协议读取邮箱中的最新验证码
 * @param {object} account - 邮箱账号配置
 * @param {string} account.imap_host - IMAP 服务器地址
 * @param {number} account.imap_port - IMAP 端口（默认 993）
 * @param {string} account.imap_user - IMAP 用户名
 * @param {string} account.imap_pass - IMAP 密码（应用专用密码）
 * @param {number} maxEmails - 最多检查的邮件数量（默认 10）
 * @returns {Promise<{success: boolean, code: string|null, error: string|null}>}
 */
async function fetchVerificationCode(account, maxEmails = 10) {
  // 检查必要参数
  if (!account || !account.imap_host || !account.imap_user || !account.imap_pass) {
    return {
      success: false,
      code: null,
      error: '邮箱 IMAP 配置不完整，请在数据库中配置 imap_pass'
    };
  }

  const client = new ImapFlow({
    host: account.imap_host,
    port: account.imap_port || 993,
    secure: true,
    auth: {
      user: account.imap_user,
      pass: account.imap_pass
    },
    logger: false // 关闭 IMAP 日志以减少输出
  });

  try {
    // 连接邮箱服务器
    await client.connect();
    console.log(`IMAP 连接成功: ${account.email}`);

    // 选择收件箱
    const lock = await client.getMailboxLock('INBOX');
    let foundCode = null;

    try {
      // 搜索最近的未读邮件（最近 30 分钟内的）
      const since = new Date(Date.now() - 30 * 60 * 1000);
      const searchCriteria = [
        { unseen: true },
        { since }
      ];

      // 如果没有未读邮件，扩大范围到最近 2 小时的所有邮件
      let messages = await client.search(searchCriteria);

      if (messages.length === 0) {
        console.log('未找到最近 30 分钟的未读邮件，扩大搜索范围...');
        const sinceExtended = new Date(Date.now() - 2 * 60 * 60 * 1000);
        messages = await client.search([{ since: sinceExtended }]);
      }

      if (messages.length === 0) {
        return {
          success: false,
          code: null,
          error: '未找到最近的邮件'
        };
      }

      // 只检查最新的几封邮件
      const messagesToCheck = messages.slice(-maxEmails);

      for (const uid of messagesToCheck) {
        // 下载邮件内容
        const message = await client.fetchOne(uid, {
          envelope: true,
          source: true
        }, { uid: true });

        // 获取邮件正文
        let bodyText = '';

        if (message.source) {
          // 将 Buffer 转为字符串
          const sourceStr = message.source.toString('utf-8');

          // 简单提取纯文本部分（去除 HTML 标签）
          bodyText = sourceStr
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')  // 去除 style
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')  // 去除 script
            .replace(/<[^>]+>/g, ' ')                          // 去除 HTML 标签
            .replace(/&nbsp;/g, ' ')                           // 替换 HTML 实体
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/\s+/g, ' ')                              // 合并空白
            .trim();
        }

        // 尝试提取验证码
        const code = extractCode(bodyText);
        if (code) {
          foundCode = code;
          console.log(`在邮件中找到验证码: ${code} (UID: ${uid})`);
          break;
        }
      }
    } finally {
      lock.release();
    }

    await client.logout();

    if (foundCode) {
      return {
        success: true,
        code: foundCode,
        error: null
      };
    } else {
      return {
        success: false,
        code: null,
        error: '未在最近的邮件中找到验证码'
      };
    }

  } catch (err) {
    console.error(`IMAP 读取失败 (${account.email}):`, err.message);

    // 尝试关闭连接
    try {
      await client.logout();
    } catch (_) {
      // 忽略关闭错误
    }

    return {
      success: false,
      code: null,
      error: `邮箱连接失败: ${err.message}`
    };
  }
}

// ==================== 批量读取 ====================

/**
 * 从多个邮箱账号中读取验证码（并行）
 * @param {Array} accounts - 邮箱账号配置数组
 * @returns {Promise<Array>} 每个邮箱的读取结果
 */
async function fetchFromMultipleAccounts(accounts) {
  const results = [];

  // 并行读取所有邮箱（设置超时保护）
  const promises = accounts.map(async (account) => {
    try {
      // 每个邮箱读取设置 15 秒超时
      const result = await Promise.race([
        fetchVerificationCode(account),
        new Promise((resolve) =>
          setTimeout(() => resolve({
            success: false,
            code: null,
            error: '读取超时（15秒）',
            email: account.email
          }), 15000)
        )
      ]);
      result.email = account.email;
      result.id = account.id;
      return result;
    } catch (err) {
      return {
        success: false,
        code: null,
        error: err.message,
        email: account.email,
        id: account.id
      };
    }
  });

  return Promise.all(promises);
}

module.exports = {
  extractCode,
  fetchVerificationCode,
  fetchFromMultipleAccounts,
};
