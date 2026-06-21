/**
 * Supabase 数据库操作模块
 * 管理微信用户绑定、邮箱账号配置、验证码缓存和操作日志
 */

const { createClient } = require('@supabase/supabase-js');

// 从环境变量读取 Supabase 配置
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ebrzdghrzotwrnkimpzi.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVicnpkZ2hyem90d3Jua2ltcHppIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIwNDQ3NjQsImV4cCI6MjA5NzYyMDc2NH0.29EyMKsL9TYMVRtlUbwPA3pAaFfsJlf3JvfPQRQVZIo';

// 创建 Supabase 客户端（单例模式）
let _supabase = null;

function getSupabase() {
  if (!_supabase) {
    _supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  }
  return _supabase;
}

// ==================== 微信用户绑定 ====================

/**
 * 根据 openid 查询用户绑定信息
 * @param {string} openid - 微信用户的 openid
 * @returns {object|null} 绑定记录，未找到返回 null
 */
async function getBindingByOpenid(openid) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('wechat_bindings')
    .select('*, email_accounts(*)')
    .eq('openid', openid)
    .maybeSingle();

  if (error) {
    console.error('查询用户绑定失败:', error.message);
    return null;
  }
  return data;
}

/**
 * 绑定微信用户到邮箱账号
 * @param {string} openid - 微信用户的 openid
 * @param {string} emailAccountId - 邮箱账号 ID
 * @param {string} nickname - 用户昵称（可选）
 * @returns {boolean} 是否成功
 */
async function bindUser(openid, emailAccountId, nickname = null) {
  const supabase = getSupabase();

  // 先检查邮箱账号是否存在
  const { data: account, error: accountError } = await supabase
    .from('email_accounts')
    .select('id, email')
    .eq('id', emailAccountId)
    .maybeSingle();

  if (accountError || !account) {
    console.error('邮箱账号不存在:', emailAccountId);
    return false;
  }

  // 使用 upsert，如果已绑定则更新
  const { error } = await supabase
    .from('wechat_bindings')
    .upsert({
      openid,
      nickname,
      email_account_id: emailAccountId,
      bound_at: new Date().toISOString()
    }, { onConflict: 'openid' });

  if (error) {
    console.error('绑定用户失败:', error.message);
    return false;
  }

  // 记录日志
  await addLog(openid, 'bind', `绑定到邮箱: ${account.email}`);

  return true;
}

/**
 * 解绑用户
 * @param {string} openid - 微信用户的 openid
 * @returns {boolean} 是否成功
 */
async function unbindUser(openid) {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('wechat_bindings')
    .delete()
    .eq('openid', openid);

  if (error) {
    console.error('解绑用户失败:', error.message);
    return false;
  }

  await addLog(openid, 'unbind', '解绑邮箱');
  return true;
}

// ==================== 邮箱账号管理 ====================

/**
 * 获取所有邮箱账号配置
 * @returns {Array} 邮箱账号列表
 */
async function getAllEmailAccounts() {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('email_accounts')
    .select('*')
    .order('id');

  if (error) {
    console.error('获取邮箱账号列表失败:', error.message);
    return [];
  }
  return data || [];
}

/**
 * 根据 ID 获取邮箱账号
 * @param {string} id - 邮箱账号 ID
 * @returns {object|null} 邮箱账号信息
 */
async function getEmailAccountById(id) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('email_accounts')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error) {
    console.error('获取邮箱账号失败:', error.message);
    return null;
  }
  return data;
}

/**
 * 根据邮箱地址获取邮箱账号
 * @param {string} email - 邮箱地址
 * @returns {object|null} 邮箱账号信息
 */
async function getEmailAccountByEmail(email) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('email_accounts')
    .select('*')
    .eq('email', email.toLowerCase().trim())
    .maybeSingle();

  if (error) {
    console.error('获取邮箱账号失败:', error.message);
    return null;
  }
  return data;
}

/**
 * 添加或更新邮箱账号
 * @param {object} account - 邮箱账号信息
 * @returns {boolean} 是否成功
 */
async function upsertEmailAccount(account) {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('email_accounts')
    .upsert(account, { onConflict: 'id' });

  if (error) {
    console.error('保存邮箱账号失败:', error.message);
    return false;
  }
  return true;
}

// ==================== 验证码缓存 ====================

/**
 * 保存验证码到缓存
 * @param {string} emailAccountId - 邮箱账号 ID
 * @param {string} code - 验证码
 * @returns {boolean} 是否成功
 */
async function saveVerificationCode(emailAccountId, code) {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('verification_codes')
    .insert({
      email_account_id: emailAccountId,
      code
    });

  if (error) {
    console.error('保存验证码失败:', error.message);
    return false;
  }
  return true;
}

/**
 * 获取指定邮箱账号的最新验证码
 * @param {string} emailAccountId - 邮箱账号 ID
 * @returns {object|null} 最新的未使用验证码记录
 */
async function getLatestCode(emailAccountId) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('verification_codes')
    .select('*')
    .eq('email_account_id', emailAccountId)
    .eq('used', false)
    .order('fetched_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error('获取验证码失败:', error.message);
    return null;
  }
  return data;
}

/**
 * 标记验证码为已使用
 * @param {string} codeId - 验证码记录 ID
 * @param {string} openid - 使用者的 openid
 * @returns {boolean} 是否成功
 */
async function markCodeUsed(codeId, openid) {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('verification_codes')
    .update({
      used: true,
      used_by_openid: openid,
      used_at: new Date().toISOString()
    })
    .eq('id', codeId);

  if (error) {
    console.error('标记验证码已使用失败:', error.message);
    return false;
  }
  return true;
}

// ==================== 操作日志 ====================

/**
 * 添加操作日志
 * @param {string} openid - 用户 openid（可选）
 * @param {string} action - 操作类型
 * @param {string} detail - 操作详情
 */
async function addLog(openid, action, detail) {
  const supabase = getSupabase();
  try {
    await supabase.from('bot_logs').insert({
      openid: openid || null,
      action,
      detail
    });
  } catch (err) {
    // 日志写入失败不影响主流程
    console.error('写入日志失败:', err.message);
  }
}

// ==================== 初始化数据 ====================

/**
 * 初始化预设的邮箱账号数据
 * 仅在表为空时插入
 */
async function initEmailAccounts() {
  const supabase = getSupabase();
  const { count } = await supabase
    .from('email_accounts')
    .select('*', { count: 'exact', head: true });

  if (count > 0) {
    console.log('邮箱账号表已有数据，跳过初始化');
    return;
  }

  // 预设 8 个邮箱账号（IMAP 密码需要用户后续配置）
  const defaultAccounts = [
    { id: 'gmail-1', email: 'gptcarpool1@gmail.com', imap_host: 'imap.gmail.com', imap_port: 993, imap_user: 'gptcarpool1@gmail.com', imap_pass: '', type: 'gmail' },
    { id: 'gmail-2', email: 'gptcarpool2@gmail.com', imap_host: 'imap.gmail.com', imap_port: 993, imap_user: 'gptcarpool2@gmail.com', imap_pass: '', type: 'gmail' },
    { id: 'gmail-3', email: 'gptcarpool3@gmail.com', imap_host: 'imap.gmail.com', imap_port: 993, imap_user: 'gptcarpool3@gmail.com', imap_pass: '', type: 'gmail' },
    { id: 'gmail-4', email: 'gptcarpool4@gmail.com', imap_host: 'imap.gmail.com', imap_port: 993, imap_user: 'gptcarpool4@gmail.com', imap_pass: '', type: 'gmail' },
    { id: 'outlook-1', email: 'gptcarpool1@outlook.com', imap_host: 'outlook.office365.com', imap_port: 993, imap_user: 'gptcarpool1@outlook.com', imap_pass: '', type: 'outlook' },
    { id: 'outlook-2', email: 'gptcarpool2@outlook.com', imap_host: 'outlook.office365.com', imap_port: 993, imap_user: 'gptcarpool2@outlook.com', imap_pass: '', type: 'outlook' },
    { id: 'outlook-3', email: 'gptcarpool3@outlook.com', imap_host: 'outlook.office365.com', imap_port: 993, imap_user: 'gptcarpool3@outlook.com', imap_pass: '', type: 'outlook' },
    { id: 'outlook-4', email: 'gptcarpool4@outlook.com', imap_host: 'outlook.office365.com', imap_port: 993, imap_user: 'gptcarpool4@outlook.com', imap_pass: '', type: 'outlook' },
  ];

  const { error } = await supabase
    .from('email_accounts')
    .upsert(defaultAccounts, { onConflict: 'id' });

  if (error) {
    console.error('初始化邮箱账号失败:', error.message);
  } else {
    console.log('邮箱账号初始化完成，共', defaultAccounts.length, '个');
  }
}

module.exports = {
  getSupabase,
  // 微信用户绑定
  getBindingByOpenid,
  bindUser,
  unbindUser,
  // 邮箱账号管理
  getAllEmailAccounts,
  getEmailAccountById,
  getEmailAccountByEmail,
  upsertEmailAccount,
  // 验证码缓存
  saveVerificationCode,
  getLatestCode,
  markCodeUsed,
  // 操作日志
  addLog,
  // 初始化
  initEmailAccounts,
};
