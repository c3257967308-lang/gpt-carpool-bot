# GPT 拼车验证码机器人

微信公众号验证码自动读取机器人，部署在 Vercel Serverless Functions 上。

## 功能

- 自动读取邮箱中的验证码（支持 Gmail 和 Outlook）
- 微信公众号消息交互
- 用户邮箱绑定管理
- 验证码缓存与日志记录

## 项目结构

```
gpt-carpool-bot/
├── package.json           # 项目配置和依赖
├── vercel.json            # Vercel 部署配置
├── api/
│   └── wechat.js          # 微信消息处理入口（Serverless Function）
└── lib/
    ├── wechat-crypto.js   # 微信签名验证、XML 解析、客服消息
    ├── email-reader.js    # IMAP 邮箱验证码读取
    └── supabase.js        # Supabase 数据库操作
```

## 部署步骤

### 1. Supabase 数据库初始化

在 Supabase SQL Editor 中执行以下 SQL：

```sql
-- 微信用户绑定表
create table wechat_bindings (
  id uuid default gen_random_uuid() primary key,
  openid text not null unique,
  nickname text,
  email_account_id text,
  bound_at timestamptz default now()
);

-- 邮箱账号配置表
create table email_accounts (
  id text primary key,
  email text not null unique,
  imap_host text not null,
  imap_port integer default 993,
  imap_user text,
  imap_pass text,
  type text
);

-- 验证码缓存表
create table verification_codes (
  id uuid default gen_random_uuid() primary key,
  email_account_id text not null,
  code text not null,
  fetched_at timestamptz default now(),
  used boolean default false,
  used_by_openid text,
  used_at timestamptz
);

-- 操作日志
create table bot_logs (
  id uuid default gen_random_uuid() primary key,
  openid text,
  action text,
  detail text,
  created_at timestamptz default now()
);

-- RLS 策略：全部允许访问
alter table wechat_bindings enable row level security;
alter table email_accounts enable row level security;
alter table verification_codes enable row level security;
alter table bot_logs enable row level security;

create policy "Allow all on wechat_bindings" on wechat_bindings for all using (true) with check (true);
create policy "Allow all on email_accounts" on email_accounts for all using (true) with check (true);
create policy "Allow all on verification_codes" on verification_codes for all using (true) with check (true);
create policy "Allow all on bot_logs" on bot_logs for all using (true) with check (true);
```

### 2. 配置邮箱 IMAP 密码

在 Supabase 中更新 `email_accounts` 表的 `imap_pass` 字段：

- **Gmail**: 需要 Google 账号开启两步验证，然后生成"应用专用密码"
  - Google 账号 -> 安全性 -> 两步验证 -> 应用专用密码
- **Outlook**: 直接使用账号密码（部分账号可能需要应用密码）

```sql
-- 示例：更新 Gmail 邮箱的 IMAP 密码
update email_accounts set imap_pass = 'xxxx xxxx xxxx xxxx' where id = 'gmail-1';
```

### 3. Vercel 环境变量配置

在 Vercel 项目设置中添加以下环境变量：

| 变量名 | 说明 | 示例值 |
|--------|------|--------|
| `WECHAT_TOKEN` | 微信公众号 Token | `gptcarpool2026` |
| `WECHAT_APPID` | 微信公众号 AppID | `wxdb892d2a0b4a3c47` |
| `WECHAT_APPSECRET` | 微信公众号 AppSecret | `88c635622a67a66c7cd457cfd5b3cfc6` |
| `SUPABASE_URL` | Supabase 项目 URL | `https://ebrzdghrzotwrnkimpzi.supabase.co` |
| `SUPABASE_KEY` | Supabase anon key | `eyJ...` |

### 4. 微信公众号配置

1. 登录微信公众平台 (mp.weixin.qq.com)
2. 进入"开发" -> "基本配置"
3. 设置服务器地址为: `https://你的vercel域名/api/wechat`
4. 设置 Token 为: `gptcarpool2026`
5. 消息加解密方式选择"明文模式"
6. 点击"提交"完成验证

### 5. 部署

```bash
# 安装依赖
npm install

# 本地开发
vercel dev

# 部署到 Vercel
vercel --prod
```

## 使用说明

用户在微信公众号中发送消息与机器人交互：

| 命令 | 说明 |
|------|------|
| `验证码` 或 `code` | 读取绑定邮箱的最新验证码 |
| `绑定 邮箱地址` | 绑定邮箱账号（如：`绑定 test@gmail.com`） |
| `解绑` | 解除当前邮箱绑定 |
| `状态` | 查看当前绑定状态 |
| `帮助` 或 `help` | 显示帮助信息 |

## 技术说明

- **消息模式**: 明文模式（个人订阅号不支持加密）
- **异步回复**: 先回复"正在获取"，再通过客服消息接口推送结果
- **access_token 缓存**: 2 小时有效期，自动刷新
- **IMAP 超时**: 每个邮箱 15 秒超时保护
- **验证码匹配**: 支持多种验证码格式的正则提取
