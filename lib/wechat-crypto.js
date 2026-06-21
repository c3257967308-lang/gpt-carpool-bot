/**
 * 微信消息加解密与 XML 处理模块
 * - 签名验证（明文模式）
 * - XML 消息解析与生成
 * - 客服消息接口（异步推送消息给用户）
 */

const crypto = require('crypto');
const { parseStringPromise, Builder } = require('xml2js');

// 微信配置
const WECHAT_APPID = process.env.WECHAT_APPID || 'wxdb892d2a0b4a3c47';
const WECHAT_APPSECRET = process.env.WECHAT_APPSECRET || '88c635622a67a66c7cd457cfd5b3cfc6';
const WECHAT_TOKEN = process.env.WECHAT_TOKEN || 'gptcarpool2026';

// access_token 缓存
let _accessToken = null;
let _tokenExpiresAt = 0;

// ==================== 签名验证 ====================

/**
 * 验证微信服务器签名
 * 用于 GET 请求时的服务器验证
 * @param {string} signature - 微信加密签名
 * @param {string} timestamp - 时间戳
 * @param {string} nonce - 随机数
 * @returns {boolean} 签名是否有效
 */
function verifySignature(signature, timestamp, nonce) {
  const token = WECHAT_TOKEN;
  const arr = [token, timestamp, nonce].sort();
  const str = arr.join('');
  const sha1 = crypto.createHash('sha1').update(str).digest('hex');
  return sha1 === signature;
}

// ==================== XML 消息处理 ====================

/**
 * 解析微信 XML 消息为 JSON 对象
 * @param {string} xml - XML 格式的消息字符串
 * @returns {Promise<object>} 解析后的消息对象
 */
async function parseXmlMessage(xml) {
  try {
    const result = await parseStringPromise(xml, { explicitArray: false });
    return result.xml || result;
  } catch (err) {
    console.error('解析 XML 消息失败:', err.message);
    return null;
  }
}

/**
 * 将消息对象转换为微信 XML 格式的回复
 * @param {object} msg - 消息对象，包含 ToUserName, FromUserName, Content 等
 * @returns {string} XML 格式的回复字符串
 */
function buildXmlResponse(msg) {
  const builder = new Builder({
    headless: true,       // 不生成 XML 声明
    rootName: 'xml',
    cdata: true,          // 文本内容用 CDATA 包裹
    renderOpts: { pretty: false }
  });
  return builder.buildObject(msg);
}

/**
 * 构造文本回复消息
 * @param {string} toUser - 接收方 openid
 * @param {string} fromUser - 发送方（公众号的原始ID）
 * @param {string} content - 回复内容
 * @returns {string} XML 格式的回复
 */
function buildTextReply(toUser, fromUser, content) {
  const msg = {
    ToUserName: toUser,
    FromUserName: fromUser,
    CreateTime: Math.floor(Date.now() / 1000),
    MsgType: 'text',
    Content: content
  };
  return buildXmlResponse(msg);
}

// ==================== Access Token 管理 ====================

/**
 * 获取微信 access_token
 * 带缓存机制，2小时有效期
 * @returns {Promise<string|null>} access_token
 */
async function getAccessToken() {
  // 检查缓存是否有效（提前 5 分钟刷新）
  if (_accessToken && Date.now() < _tokenExpiresAt - 300000) {
    return _accessToken;
  }

  try {
    const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${WECHAT_APPID}&secret=${WECHAT_APPSECRET}`;
    const response = await fetch(url);
    const data = await response.json();

    if (data.errcode) {
      console.error('获取 access_token 失败:', data.errcode, data.errmsg);
      return null;
    }

    _accessToken = data.access_token;
    // 有效期 7200 秒（2小时）
    _tokenExpiresAt = Date.now() + data.expires_in * 1000;
    console.log('access_token 获取成功，有效期至:', new Date(_tokenExpiresAt).toISOString());

    return _accessToken;
  } catch (err) {
    console.error('获取 access_token 异常:', err.message);
    return null;
  }
}

/**
 * 强制刷新 access_token（忽略缓存）
 * @returns {Promise<string|null>} access_token
 */
async function refreshAccessToken() {
  _accessToken = null;
  _tokenExpiresAt = 0;
  return getAccessToken();
}

// ==================== 客服消息接口 ====================

/**
 * 通过客服消息接口异步推送消息给用户
 * 微信要求在用户主动发消息的 48 小时内才能发送客服消息
 * @param {string} openid - 用户的 openid
 * @param {string} content - 消息内容
 * @returns {Promise<boolean>} 是否发送成功
 */
async function sendCustomMessage(openid, content) {
  const accessToken = await getAccessToken();
  if (!accessToken) {
    console.error('无法发送客服消息: access_token 获取失败');
    return false;
  }

  try {
    const url = `https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=${accessToken}`;
    const body = {
      touser: openid,
      msgtype: 'text',
      text: {
        content: content
      }
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const data = await response.json();

    if (data.errcode !== 0) {
      console.error('发送客服消息失败:', data.errcode, data.errmsg);
      return false;
    }

    console.log('客服消息发送成功, openid:', openid);
    return true;
  } catch (err) {
    console.error('发送客服消息异常:', err.message);
    return false;
  }
}

module.exports = {
  verifySignature,
  parseXmlMessage,
  buildXmlResponse,
  buildTextReply,
  getAccessToken,
  refreshAccessToken,
  sendCustomMessage,
};
