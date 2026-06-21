/**
 * 微信公众号验证码机器人 - 消息处理入口
 * Vercel Serverless Function
 *
 * GET  请求：微信服务器验证（签名校验）
 * POST 请求：接收用户消息并处理
 */

const { verifySignature, parseXmlMessage, buildTextReply, sendCustomMessage } = require('../lib/wechat-crypto');
const { getBindingByOpenid, bindUser, getAllEmailAccounts, getEmailAccountByEmail, saveVerificationCode, addLog } = require('../lib/supabase');
const { fetchVerificationCode, fetchFromMultipleAccounts } = require('../lib/email-reader');

// ==================== 帮助文本 ====================

const HELP_TEXT = `欢迎使用 GPT 拼车验证码助手！

【功能说明】
1. 发送"验证码"或"code" → 自动读取邮箱中的最新验证码
2. 发送"绑定 邮箱地址" → 绑定你的邮箱账号（如：绑定 test@gmail.com）
3. 发送"解绑" → 解除当前邮箱绑定
4. 发送"状态" → 查看当前绑定状态
5. 发送"帮助"或"help" → 显示本帮助信息

【注意事项】
- 首次使用请先绑定邮箱
- 验证码读取需要邮箱已配置 IMAP 密码
- Gmail 用户需要使用"应用专用密码"
- 如有问题请联系管理员`;

// ==================== 主处理函数 ====================

/**
 * Vercel Serverless Function 入口
 */
module.exports = async (req, res) => {
  try {
    // 只允许 GET 和 POST 请求
    if (req.method !== 'GET' && req.method !== 'POST') {
      return res.status(405).send('Method Not Allowed');
    }

    if (req.method === 'GET') {
      return handleVerify(req, res);
    } else {
      return handleMessage(req, res);
    }
  } catch (err) {
    console.error('未捕获的异常:', err);
    return res.status(500).send('Internal Server Error');
  }
};

// ==================== GET: 微信服务器验证 ====================

/**
 * 处理微信服务器的验证请求
 * 微信会发送 signature, timestamp, nonce, echostr 四个参数
 * 验证通过后返回 echostr
 */
function handleVerify(req, res) {
  const { signature, timestamp, nonce, echostr } = req.query;

  // 参数校验
  if (!signature || !timestamp || !nonce || !echostr) {
    console.warn('微信验证请求缺少参数');
    return res.status(400).send('Missing parameters');
  }

  // 验证签名
  const isValid = verifySignature(signature, timestamp, nonce);
  if (!isValid) {
    console.error('微信签名验证失败');
    return res.status(403).send('Invalid signature');
  }

  console.log('微信服务器验证成功');
  return res.status(200).send(echostr);
}

// ==================== POST: 消息处理 ====================

/**
 * 处理用户发送的消息
 * 先立即回复"收到"，然后异步处理业务逻辑并通过客服消息推送结果
 */
async function handleMessage(req, res) {
  // 解析 XML 消息
  const rawBody = req.body;
  const message = await parseXmlMessage(rawBody);

  if (!message) {
    console.error('无法解析消息');
    return res.status(400).send('Bad Request');
  }

  const {
    MsgType,       // 消息类型
    FromUserName,  // 发送者 openid
    ToUserName,    // 接收者（公众号）
    Content,       // 文本内容
    MsgId          // 消息 ID
  } = message;

  // 只处理文本消息
  if (MsgType !== 'text') {
    return res.status(200).send(buildTextReply(FromUserName, ToUserName, HELP_TEXT));
  }

  const content = (Content || '').trim().toLowerCase();
  console.log(`收到消息: [${FromUserName}] ${Content}`);

  // 记录日志
  await addLog(FromUserName, 'receive_message', Content);

  // 根据消息内容分发处理
  let replyText = '';

  if (content === '验证码' || content === 'code') {
    // 先立即回复"正在获取"
    replyText = '正在获取验证码，请稍候...';
    res.status(200).send(buildTextReply(FromUserName, ToUserName, replyText));

    // 异步处理验证码获取
    handleFetchCode(FromUserName).catch(err => {
      console.error('异步获取验证码异常:', err);
    });
    return; // 已经发送了响应，直接返回

  } else if (content.startsWith('绑定')) {
    // 绑定邮箱
    const email = (Content || '').trim().replace(/^绑定\s*/i, '').trim();
    replyText = await handleBind(FromUserName, email);

  } else if (content === '解绑' || content === 'unbind') {
    // 解绑邮箱
    replyText = await handleUnbind(FromUserName);

  } else if (content === '状态' || content === 'status') {
    // 查看绑定状态
    replyText = await handleStatus(FromUserName);

  } else if (content === '帮助' || content === 'help' || content === '?') {
    // 帮助信息
    replyText = HELP_TEXT;

  } else {
    // 其他消息，返回使用指南
    replyText = `你好！我没有理解你的消息。\n\n发送"帮助"查看使用说明。`;
  }

  return res.status(200).send(buildTextReply(FromUserName, ToUserName, replyText));
}

// ==================== 业务处理函数 ====================

/**
 * 异步获取验证码并通过客服消息推送
 * @param {string} openid - 用户 openid
 */
async function handleFetchCode(openid) {
  try {
    // 查询用户绑定信息
    const binding = await getBindingByOpenid(openid);

    if (!binding || !binding.email_account_id) {
      await sendCustomMessage(openid, '你还没有绑定邮箱账号。\n\n请发送"绑定 邮箱地址"来绑定你的邮箱。\n例如：绑定 test@gmail.com');
      await addLog(openid, 'fetch_code_fail', '未绑定邮箱');
      return;
    }

    const account = binding.email_accounts;

    if (!account || !account.imap_pass) {
      await sendCustomMessage(openid, `绑定的邮箱 ${account?.email || '未知'} 尚未配置 IMAP 密码。\n\n请联系管理员配置邮箱的应用专用密码。`);
      await addLog(openid, 'fetch_code_fail', 'IMAP 密码未配置');
      return;
    }

    // 读取邮箱验证码
    await sendCustomMessage(openid, `正在从 ${account.email} 读取验证码...`);

    const result = await fetchVerificationCode(account);

    if (result.success && result.code) {
      // 保存验证码到缓存
      await saveVerificationCode(account.id, result.code);

      const replyMsg = `验证码获取成功！\n\n邮箱: ${account.email}\n验证码: ${result.code}\n\n请尽快使用，验证码可能会过期。`;
      await sendCustomMessage(openid, replyMsg);
      await addLog(openid, 'fetch_code_success', `邮箱: ${account.email}, 验证码: ${result.code}`);

    } else {
      const errorMsg = `未能从 ${account.email} 获取到验证码。\n\n原因: ${result.error || '未知错误'}\n\n建议:\n1. 确认验证码邮件已发送\n2. 稍后再试\n3. 联系管理员`;
      await sendCustomMessage(openid, errorMsg);
      await addLog(openid, 'fetch_code_fail', result.error || '未知错误');
    }

  } catch (err) {
    console.error('获取验证码异常:', err);
    await sendCustomMessage(openid, '获取验证码时发生错误，请稍后再试。');
    await addLog(openid, 'fetch_code_error', err.message);
  }
}

/**
 * 处理绑定邮箱请求
 * @param {string} openid - 用户 openid
 * @param {string} email - 邮箱地址
 * @returns {string} 回复文本
 */
async function handleBind(openid, email) {
  if (!email || !email.includes('@')) {
    return '绑定格式不正确。\n\n请发送: 绑定 邮箱地址\n例如: 绑定 test@gmail.com';
  }

  // 查找邮箱账号
  const account = await getEmailAccountByEmail(email);

  if (!account) {
    return `未找到邮箱账号: ${email}\n\n请确认邮箱地址是否正确。\n当前支持的邮箱需要管理员预先配置。`;
  }

  if (!account.imap_pass) {
    return `邮箱 ${email} 尚未配置 IMAP 密码，暂时无法绑定。\n\n请联系管理员配置邮箱的应用专用密码后再试。`;
  }

  // 执行绑定
  const success = await bindUser(openid, account.id);

  if (success) {
    return `绑定成功！\n\n邮箱: ${email}\n类型: ${account.type === 'gmail' ? 'Gmail' : 'Outlook'}\n\n现在你可以发送"验证码"来获取验证码了。`;
  } else {
    return '绑定失败，请稍后再试或联系管理员。';
  }
}

/**
 * 处理解绑请求
 * @param {string} openid - 用户 openid
 * @returns {string} 回复文本
 */
async function handleUnbind(openid) {
  const { unbindUser } = require('../lib/supabase');
  const success = await unbindUser(openid);

  if (success) {
    return '已解除邮箱绑定。\n\n你可以发送"绑定 邮箱地址"来绑定新的邮箱。';
  } else {
    return '解绑失败，你可能还没有绑定邮箱。';
  }
}

/**
 * 处理状态查询请求
 * @param {string} openid - 用户 openid
 * @returns {string} 回复文本
 */
async function handleStatus(openid) {
  const binding = await getBindingByOpenid(openid);

  if (!binding || !binding.email_account_id) {
    return '当前状态: 未绑定\n\n发送"绑定 邮箱地址"来绑定你的邮箱。';
  }

  const account = binding.email_accounts;
  const bindTime = new Date(binding.bound_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

  let statusText = `当前状态: 已绑定\n\n`;
  statusText += `邮箱: ${account?.email || '未知'}\n`;
  statusText += `类型: ${account?.type === 'gmail' ? 'Gmail' : 'Outlook'}\n`;
  statusText += `IMAP: ${account?.imap_pass ? '已配置' : '未配置'}\n`;
  statusText += `绑定时间: ${bindTime}\n`;

  return statusText;
}
