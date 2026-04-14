# Hotmail 验证码抓取 API 对接说明

本文档说明如何对接本项目提供的本地 HTTP API，用于从 Outlook/Hotmail 网页邮箱中抓取验证码。

## 功能概览

当前 API 支持：

- 使用 `邮箱 + 密码` 登录 Outlook Web
- 自动检查：
  - `Inbox`
  - `Junk Email`
- 扫描最近几封邮件摘要并提取验证码
- 首次成功登录后保留登录状态
- 直到调用释放接口前，都持续复用该账号的登录状态

这意味着：

- 第一次 `POST /fetch-code` 会完成登录并返回验证码
- 后续同账号再调 `POST /fetch-code` 时会优先复用会话，响应更快
- 只有调用 `POST /release-session` 后，才会清理该账号的登录状态

## 1. 准备账号文件

在项目根目录准备 `accounts.csv`：

```csv
id,email,password
testacct,your_email@hotmail.com,your_password
```

字段说明：

- `id`：调用 API 时使用的账号标识
- `email`：Hotmail / Outlook 邮箱
- `password`：邮箱密码

## 2. 安装依赖

```powershell
pip install -r requirements.txt
python -m playwright install chromium
```

## 3. 启动 API

在项目的 `hotmail-service` 目录下执行：

```powershell
python -m uvicorn app.main:app --host 127.0.0.1 --port 8001
```

服务地址：

- 健康检查：`http://127.0.0.1:8001/health`
- 抓码接口：`http://127.0.0.1:8001/fetch-code`
- 直传邮箱抓码：`http://127.0.0.1:8001/fetch-code-direct`
- 直传邮箱列邮件：`http://127.0.0.1:8001/messages-direct`
- 释放会话：`http://127.0.0.1:8001/release-session`

## 4. 健康检查

### 请求

```http
GET /health
```

### 返回示例

```json
{
  "status": "ok",
  "csv_loaded": true,
  "csv_path": "C:\\Users\\user\\Desktop\\hot\\accounts.csv",
  "account_count": 1,
  "browser_ready": true,
  "browser_reason": null,
  "headless": true,
  "artifacts_dir": "C:\\Users\\user\\Desktop\\hot\\output\\playwright"
}
```

## 5. 获取验证码

### 请求

```http
POST /fetch-code
Content-Type: application/json
```

### 请求体

```json
{
  "account": "testacct",
  "max_wait_seconds": 20,
  "poll_interval_seconds": 3
}
```

### 字段说明

- `account`：必填
  - 优先匹配 `accounts.csv` 中的 `id`
  - 如果 `id` 未命中，再匹配 `email`
- `max_wait_seconds`：可选
  - 整次抓取允许的最大等待时间
- `poll_interval_seconds`：可选
  - 轮询间隔
- `min_created_at_ms`：可选
  - 当前默认模式下仅用于诊断记录和候选分析，不再作为默认硬过滤条件
- `exclude_codes`：可选
  - 排除已使用过的验证码

### 成功返回示例

```json
{
  "status": "ok",
  "source": "playwright",
  "folder": "Junk Email",
  "subject": "Your ChatGPT code is 203996",
  "sender": "otp@tm1.openai.com",
  "received_at": "9:11",
  "received_at_ms": 1775802660000,
  "code": "203996",
  "matched_regex": "numeric_code",
  "preview": "Your ChatGPT code is 203996...",
  "reason": null
}
```

### 返回字段

- `status`
  - `ok`
  - `login_failed`
  - `security_challenge`
  - `mailbox_load_failed`
  - `no_code_found`
  - `timeout`
- `folder`
  - `Inbox` 或 `Junk Email`
- `subject`
  - 邮件主题或邮件列表摘要主题
- `sender`
  - 发件人邮箱
- `received_at`
  - 页面上解析到的时间
- `received_at_ms`
  - 归一化后的时间戳，便于业务侧比较新旧
  - 当前主要用于排序和诊断，不再默认阻断候选返回
- `code`
  - 提取到的验证码
- `matched_regex`
  - 命中的提取规则
- `preview`
  - 邮件预览摘要
- `reason`
  - 失败原因

## 6. 释放登录状态

### 请求

```http
POST /release-session
Content-Type: application/json
```

### 请求体

```json
{
  "account": "testacct"
}
```

### 返回示例

```json
{
  "status": "released",
  "account": "testacct",
  "released": true,
  "session_path": "C:\\Users\\user\\Desktop\\hot\\output\\playwright\\sessions\\testacct.json",
  "reason": null
}
```

### 语义说明

- `released=true`
  - 表示该账号的登录状态缓存已清理
- `released=false`
  - 表示该账号当前没有已缓存的登录状态

## 7. 直接传邮箱抓码

### 请求

```http
POST /fetch-code-direct
Content-Type: application/json
```

### 请求体

```json
{
  "email": "your_email@hotmail.com",
  "password": "your_password",
  "max_wait_seconds": 20,
  "poll_interval_seconds": 3
}
```

### 说明

- 不要求该邮箱提前写入 `accounts.csv`
- 会话缓存按邮箱地址保存
- 之后可以继续调用 `/fetch-code-direct`
- 也可以直接用邮箱地址调用 `/release-session` 释放该会话

## 8. 会话生命周期

当前版本的会话规则是：

1. 第一次调用 `POST /fetch-code`
   - 自动登录邮箱
   - 抓取验证码
   - 保存登录状态

2. 后续继续调用 `POST /fetch-code`
   - 优先复用登录状态
   - 不主动释放

3. 只有在以下情况下会丢弃登录状态：
   - 你主动调用 `POST /release-session`
   - 登录状态已失效，系统检测到必须重新登录
   - Microsoft 出现安全挑战，当前会话不可继续使用

## 8.1 直接列邮件

### 请求

```http
POST /messages-direct
Content-Type: application/json
```

### 请求体

与 `POST /fetch-code-direct` 基本一致：

```json
{
  "email": "your_email@hotmail.com",
  "password": "your_password",
  "client_id": "optional-client-id",
  "refresh_token": "optional-refresh-token",
  "access_method": "playwright"
}
```

### 返回说明

返回结构与 `graph` 路径统一，包含：

- `status`
- `email`
- `access_method`
- `resolved_method`
- `available_methods`
- `supports_listing`
- `messages`
- `total_messages`

每封邮件项包含：

- `folder`
- `subject`
- `sender`
- `received_at`
- `received_at_ms`
- `preview`
- `body`
- `source`

## 9. 调用示例

### PowerShell

```powershell
$body = @{
  account = "testacct"
  max_wait_seconds = 20
  poll_interval_seconds = 3
} | ConvertTo-Json

Invoke-RestMethod `
  -Uri "http://127.0.0.1:8001/fetch-code" `
  -Method Post `
  -ContentType "application/json" `
  -Body $body
```

### Python

```python
import requests

resp = requests.post(
    "http://127.0.0.1:8001/fetch-code",
    json={
        "account": "testacct",
        "max_wait_seconds": 20,
        "poll_interval_seconds": 3,
    },
    timeout=180,
)

print(resp.status_code)
print(resp.json())
```

### Python 释放会话

```python
import requests

resp = requests.post(
    "http://127.0.0.1:8001/release-session",
    json={"account": "testacct"},
    timeout=30,
)

print(resp.status_code)
print(resp.json())
```

### Python 直传邮箱抓码

```python
import requests

resp = requests.post(
    "http://127.0.0.1:8001/fetch-code-direct",
    json={
        "email": "your_email@hotmail.com",
        "password": "your_password",
        "max_wait_seconds": 20,
        "poll_interval_seconds": 3,
    },
    timeout=180,
)

print(resp.status_code)
print(resp.json())
```

### Python 直传邮箱列邮件

```python
import requests

resp = requests.post(
    "http://127.0.0.1:8001/messages-direct",
    json={
        "email": "your_email@hotmail.com",
        "password": "your_password",
        "access_method": "playwright",
    },
    timeout=180,
)

print(resp.status_code)
print(resp.json())
```

## 10. 推荐接入方式

建议业务侧按下面流程使用：

1. 启动服务后先调一次 `/health`
2. 要收码时调用 `/fetch-code`
3. 拿到 `status=ok` 后直接使用 `code`
4. 同账号短时间内重复收码时继续调 `/fetch-code`
5. 该账号后续不再使用时，调用 `/release-session`

## 11. 错误处理建议

- `login_failed`
  - 账号密码错误，或登录没有成功进入邮箱页
- `security_challenge`
  - Microsoft 要求额外验证，不适合无人值守
- `mailbox_load_failed`
  - 页面结构异常、页面拦截或 Playwright 交互失败
- `no_code_found`
  - 已进入邮箱，但没有发现匹配验证码
- `timeout`
  - 在给定时间内未完成抓取

建议：

- `mailbox_load_failed` / `timeout`：可重试 1 次
- `login_failed` / `security_challenge`：标记账号异常

## 12. 调试产物

失败时会写入：

`./output/playwright`

常见文件：

- `failure.png`
- `trace.zip`
- `console.json`

用于排查：

- 登录异常
- Microsoft 风控页
- Outlook 邮件列表浮层拦截
- 页面 DOM 结构变化


## Graph / IMAP mode

`/fetch-code-direct` also accepts:

```json
{
  "email": "your_email@hotmail.com",
  "client_id": "your-client-id",
  "refresh_token": "your-refresh-token",
  "access_method": "graph"
}
```

Supported `access_method` values:

- `auto`
- `playwright`
- `graph`
- `imap_new`
- `imap_old`

OAuth helper endpoints:

- `GET /oauth/auth-url`
- `POST /oauth/exchange-token`
