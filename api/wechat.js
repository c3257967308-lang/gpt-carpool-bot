/**
 * 微信公众号验证码机器人 - 消息处理入口
 * Vercel Serverless Function
 */

const crypto = require('crypto');

// 配置
const WECHAT_TOKEN = process.env.WECHAT_TOKEN || 'gptcarpool2026';
const WECHAT_APPID = process.env.WECHAT_APPID || 'wxdb892d2a0b4a3c47';
const WECHAT_APPSECRET = process.env.WECHAT_APPSECRET || '88c635622a67a66c7cd457cfd5b3cfc6';
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ebrzdghrzotwrnkimpzi.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVicnpkZ2hyem90d3Jua2ltcHppIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIwNDQ3NjQsImV4cCI6MjA5NzYyMDc2NH0.29EyMKsL9TYMVRtlUbwPA3pAaFfsJlf3JvfPQRQVZIo';

const HELP_TEXT = `欢迎使用 GPT 拼车验证码助手！

【功能说明】
1. 发送"验证码"或"code" → 获取验证码
2. 发送"绑定 邮箱地址" → 绑定邮箱账号
3. 发送"解绑" → 解除绑定
4. 发送"状态" → 查看绑定状态
5. 发送"帮助"或"help" → 显示本帮助

【注意】
首次使用请先发送"绑定 邮箱地址"绑定你的ChatGPT账号邮箱。`;

// access_token 缓存
let _accessToken = null;
let _tokenExpiresAt = 0;

// ==================== 主入口 ====================

module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      return handleVerify(req, res);
    }
    if (req.method === 'POST') {
      return handleMessage(req, res);
    }
    return res.status(405).send('Method Not Allowed');
  } catch (err) {
    console.error('Error:', err.message || err);
    return res.status(200).send('success');
  }
};

// ==================== GET: 签名验证 ====================

function handleVerify(req, res) {
  const { signature, timestamp, nonce, echostr } = req.query;
  if (!signature || !timestamp || !nonce || !echostr) {
    return res.status(400).send('Missing params');
  }
  const arr = [WECHAT_TOKEN, timestamp, nonce].sort();
  const sha1 = crypto.createHash('sha1').update(arr.join('')).digest('hex');
  if (sha1 !== signature) {
    return res.status(403).send('Invalid signature');
  }
  return res.status(200).send(echostr);
}

// ==================== POST: 消息处理 ====================

async function handleMessage(req, res) {
  try {
    // 解析 XML（手动解析，不依赖 xml2js）
    const xml = req.body;
    const getTag = (tag) => {
      const match = xml.match(new RegExp(`<${tag}><!\\[CDATA\\[(.+?)\\]\\]></${tag}>`)) || xml.match(new RegExp(`<${tag}>(.+?)</${tag}>`));
      return match ? match[1] : '';
    };

    const MsgType = getTag('MsgType');
    const FromUserName = getTag('FromUserName');
    const ToUserName = getTag('ToUserName');
    const Content = getTag('Content');

    console.log('Received:', MsgType, FromUserName, Content);

    if (MsgType === 'event') {
      // 关注事件
      const Event = getTag('Event');
      if (Event === 'subscribe') {
        return res.status(200).send(buildXmlReply(FromUserName, ToUserName, '欢迎关注 GPT 拼车验证码助手！\n\n发送"帮助"查看使用说明。'));
      }
      return res.status(200).send('success');
    }

    if (MsgType !== 'text') {
      return res.status(200).send(buildXmlReply(FromUserName, ToUserName, HELP_TEXT));
    }

    const content = Content.trim().toLowerCase();

    if (content === '帮助' || content === 'help' || content === '?') {
      return res.status(200).send(buildXmlReply(FromUserName, ToUserName, HELP_TEXT));
    }

    if (content === '验证码' || content === 'code') {
      return res.status(200).send(buildXmlReply(FromUserName, ToUserName, '验证码功能正在配置中，请稍后再试。\n\n需要管理员先配置邮箱IMAP密码。'));
    }

    if (content.startsWith('绑定')) {
      const email = Content.trim().replace(/^绑定\s*/i, '').trim();
      if (!email || !email.includes('@')) {
        return res.status(200).send(buildXmlReply(FromUserName, ToUserName, '格式不正确。\n\n请发送: 绑定 邮箱地址\n例如: 绑定 test@gmail.com'));
      }
      return res.status(200).send(buildXmlReply(FromUserName, ToUserName, `绑定请求已收到: ${email}\n\n邮箱IMAP密码尚未配置，功能将在配置完成后生效。`));
    }

    if (content === '解绑' || content === 'unbind') {
      return res.status(200).send(buildXmlReply(FromUserName, ToUserName, '解绑功能将在邮箱配置完成后生效。'));
    }

    if (content === '状态' || content === 'status') {
      return res.status(200).send(buildXmlReply(FromUserName, ToUserName, '系统正在配置中，请稍后再试。\n\n发送"帮助"查看使用说明。'));
    }

    return res.status(200).send(buildXmlReply(FromUserName, ToUserName, '你好！发送"帮助"查看使用说明。'));

  } catch (err) {
    console.error('Handle message error:', err.message || err);
    return res.status(200).send('success');
  }
}

// ==================== XML 构建 ====================

function buildXmlReply(toUser, fromUser, content) {
  const time = Math.floor(Date.now() / 1000);
  return `<xml>
<ToUserName><![CDATA[${toUser}]]></ToUserName>
<FromUserName><![CDATA[${fromUser}]]></FromUserName>
<CreateTime>${time}</CreateTime>
<MsgType><![CDATA[text]]></MsgType>
<Content><![CDATA[${content}]]></Content>
</xml>`;
}
