"""
邮箱验证码读取 API 服务
部署到 Railway，国内可访问，支持 IMAP 连接读取邮箱验证码
"""

from flask import Flask, request, jsonify
from flask_cors import CORS
import imaplib
import email
from email.header import decode_header
import re
import requests
import os
from datetime import datetime, timedelta

app = Flask(__name__)
CORS(app)

# Supabase 配置，优先使用环境变量
SUPABASE_URL = os.environ.get(
    'SUPABASE_URL',
    'https://ebrzdghrzotwrnkimpzi.supabase.co'
)
SUPABASE_KEY = os.environ.get(
    'SUPABASE_KEY',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVicnpkZ2hyem90d3Jua2ltcHppIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIwNDQ3NjQsImV4cCI6MjA5NzYyMDc2NH0.29EyMKsL9TYMVRtlUbwPA3pAaFfsJlf3JvfPQRQVZIo'
)


def get_account(email_addr):
    """从 Supabase 查询邮箱 IMAP 配置"""
    url = f"{SUPABASE_URL}/rest/v1/email_accounts"
    params = {
        'email': f'ilike.{email_addr}',
        'select': '*'
    }
    headers = {
        'apikey': SUPABASE_KEY,
        'Authorization': f'Bearer {SUPABASE_KEY}'
    }
    resp = requests.get(url, params=params, headers=headers, timeout=10)
    data = resp.json()
    if isinstance(data, list) and len(data) > 0:
        return data[0]
    return None


def extract_code(text):
    """从邮件文本中提取验证码"""
    if not text:
        return None

    # 去掉 HTML 标签
    clean = re.sub(r'<[^>]+>', ' ', text)
    clean = re.sub(r'&nbsp;', ' ', clean)
    clean = re.sub(r'&amp;', '&', clean)
    clean = re.sub(r'&lt;', '<', clean)
    clean = re.sub(r'&gt;', '>', clean)
    clean = re.sub(r'\s+', ' ', clean)

    # 多种验证码匹配模式
    patterns = [
        # 中文：验证码/确认码/安全码 后面跟数字
        r'(?:verification\s*code|验证码|code|确认码|安全码)[\s:：是]*([0-9]{4,8})',
        # 数字后面跟 "is your" / "为你的" 等
        r'([0-9]{4,8})[\s]*(?:is\s*your|为你的|是你的|是您的)',
        # "enter" / "input" / "type" 后面跟数字
        r'(?:enter|input|type)[\s:]*([0-9]{4,8})',
        # 独立的 6 位数字（最常见）
        r'(?:^|[\s\[\(（\-:>])([0-9]{6})(?:[\s\]\)）\-:,.<]|$)',
        # 4-8 位数字兜底
        r'(?:^|[\s\[\(（\-:>])([0-9]{4,8})(?:[\s\]\)）\-:,.<]|$)',
    ]

    for p in patterns:
        m = re.search(p, clean, re.IGNORECASE)
        if m:
            return m.group(1)
    return None


def decode_mime_header(header_value):
    """解码邮件头部（处理 =?UTF-8?B?...?= 等编码）"""
    if not header_value:
        return ''
    parts = decode_header(header_value)
    result = []
    for part, charset in parts:
        if isinstance(part, bytes):
            result.append(part.decode(charset or 'utf-8', errors='replace'))
        else:
            result.append(part)
    return ''.join(result)


def fetch_verification_code(account):
    """通过 IMAP 读取邮箱最新验证码"""
    if not account or not account.get('imap_host') or not account.get('imap_pass'):
        return {'success': False, 'error': '邮箱 IMAP 配置不完整'}

    host = account['imap_host']
    port = account.get('imap_port', 993)
    user = account.get('imap_user') or account['email']
    password = account['imap_pass']

    try:
        # 连接 IMAP 服务器（SSL）
        mail = imaplib.IMAP4_SSL(host, port)
        mail.login(user, password)
        mail.select('INBOX')

        # 搜索最近的未读邮件，逐步扩大时间范围
        for minutes in [30, 120, 1440]:
            since = (datetime.now() - timedelta(minutes=minutes)).strftime('%d-%b-%Y')
            status, messages = mail.search(None, '(UNSEEN)', f'SINCE {since}')

            if status == 'OK' and messages[0]:
                uids = messages[0].split()
                break
        else:
            mail.logout()
            return {'success': False, 'error': '未找到最近的邮件，请先触发验证码发送'}

        # 最多检查最近 5 封邮件
        latest = uids[-5:] if len(uids) > 5 else uids

        for uid in reversed(latest):
            try:
                status, msg_data = mail.fetch(uid, '(RFC822)')
                if status != 'OK':
                    continue

                raw_email = msg_data[0][1]
                msg = email.message_from_bytes(raw_email)

                # 提取邮件正文
                text = ''
                if msg.is_multipart():
                    for part in msg.walk():
                        content_type = part.get_content_type()
                        if content_type in ('text/plain', 'text/html'):
                            payload = part.get_payload(decode=True)
                            if payload:
                                charset = part.get_content_charset() or 'utf-8'
                                text += payload.decode(charset, errors='replace')
                else:
                    payload = msg.get_payload(decode=True)
                    if payload:
                        charset = msg.get_content_charset() or 'utf-8'
                        text = payload.decode(charset, errors='replace')

                # 同时检查邮件主题
                subject = decode_mime_header(msg.get('Subject', ''))
                full_text = subject + ' ' + text

                code = extract_code(full_text)
                if code:
                    mail.logout()
                    return {'success': True, 'code': code}
            except Exception as e:
                print(f'读取邮件 {uid} 时出错: {e}')
                continue

        mail.logout()
        return {'success': False, 'error': '在最近的邮件中未找到验证码'}

    except imaplib.IMAP4.error as e:
        return {'success': False, 'error': f'IMAP 登录失败: {str(e)}'}
    except Exception as e:
        return {'success': False, 'error': f'邮箱连接失败: {str(e)}'}


@app.route('/api/get-code')
def get_code():
    """GET /api/get-code?email=xxx - 读取邮箱验证码"""
    email_addr = (request.args.get('email') or '').strip().lower()
    if not email_addr:
        return jsonify({'success': False, 'error': '缺少 email 参数'}), 400

    try:
        # 从 Supabase 查询邮箱配置
        account = get_account(email_addr)
        if not account:
            return jsonify({'success': False, 'error': f'未找到邮箱 {email_addr} 的配置'}), 404

        # 连接 IMAP 读取验证码
        result = fetch_verification_code(account)
        return jsonify(result)
    except Exception as e:
        return jsonify({'success': False, 'error': f'服务器错误: {str(e)}'}), 500


@app.route('/health')
def health():
    """健康检查接口"""
    return jsonify({'status': 'ok'})


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=int(os.environ.get('PORT', 5000)))
