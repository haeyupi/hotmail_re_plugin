# hotmail-service

> Local FastAPI companion service for Hotmail / Outlook verification-code fetching  
> 仓库中的本地辅助服务，负责 Hotmail 收码、SQLite 账号池管理、OAuth helper，以及 WebUI 管理页面。

如果你想先了解整个项目，建议先读：[`../README.md`](../README.md)

---

## 这个服务是做什么的 / What this service does

`hotmail-service` 主要负责两件事：

1. **Hotmail / Outlook 验证码抓取**
2. **Hotmail 批量账号数据库管理**

扩展本身不直接执行复杂的 Outlook Web / Graph / IMAP 收码逻辑，而是通过 HTTP 请求调用这个服务。

---

## 当前能力 / Current capabilities

### 1. 多种收码方式 / Multiple access methods

`/fetch-code-direct` 当前支持：

- `playwright`
- `graph`
- `imap_new`
- `imap_old`
- `auto`

其中：

- `graph` / `imap_new` / `imap_old` 更适合作为稳定主链路
- `playwright` 适合只有邮箱密码、没有 token 的情况
- `auto` 会优先尝试 token 路径，再按条件回退

### 2. 本地 SQLite 账号库 / Local SQLite account DB

默认数据库路径：

```text
data/hotmail_accounts.db
```

用于管理批量账号状态：

- `pending`
- `claimed`
- `success`
- `failed`

### 3. 内置 WebUI

服务内置：

```text
/accounts/ui
```

支持：

- 查看账号列表
- 按状态筛选
- 单条编辑
- 批量更新状态和标签
- 批量删除
- 清空数据库
- 重置 `claimed`

### 4. OAuth helper

当前提供：

- `GET /oauth/auth-url`
- `POST /oauth/exchange-token`

可用于把 callback URL 或 authorization code 交换成 token。

### 5. Playwright 会话缓存

成功登录后，Playwright 会话状态会缓存到本地，用于减少重复登录开销。

---

## 安装 / Install

在 `hotmail-service` 目录下执行：

```powershell
pip install -r requirements.txt
python -m playwright install chromium
```

依赖包括：

- `fastapi`
- `uvicorn`
- `playwright`
- `pydantic`
- `pytest`
- `httpx`
- `requests`

---

## 启动 / Run

### 方式 1：使用启动脚本

在仓库根目录执行：

```powershell
powershell -ExecutionPolicy Bypass -File ".\hotmail-service\start_hotmail_service.ps1"
```

### 方式 2：手动启动

```powershell
cd .\hotmail-service
uvicorn app.main:app --host 127.0.0.1 --port 8001
```

默认监听地址：

```text
http://127.0.0.1:8001
```

---

## 健康检查 / Health check

请求：

```http
GET /health
```

返回内容通常包括：

- `status`
- `csv_loaded`
- `csv_path`
- `account_count`
- `browser_ready`
- `browser_reason`
- `headless`
- `artifacts_dir`
- `oauth_helper_redirect_uri`
- `oauth_helper_client_id`

### `status` 的意义

- `ok`：服务在线，且 CSV / 浏览器依赖可用
- `degraded`：服务在线，但 CSV 或 Playwright 环境存在问题

---

## API 概览 / API overview

## 1. 账号数据库相关 / Account DB APIs

### 导入账号

```http
POST /accounts/import
```

请求体：

```json
{
  "raw_text": "email----password----client_id----refresh_token"
}
```

### 查看汇总

```http
GET /accounts/summary
```

返回：

- `total`
- `pending`
- `claimed`
- `success`
- `failed`

### 列表查询

```http
GET /accounts
```

支持按 `workflow_status` 过滤。

### 打开 WebUI

```http
GET /accounts/ui
```

### 批量更新

```http
POST /accounts/batch-update
```

### 重置已领取状态

```http
POST /accounts/reset-claimed
```

### 领取下一条账号

```http
POST /accounts/claim-next
```

行为：

- 只领取 `pending`
- 领取后改成 `claimed`

### 标记结果

```http
POST /accounts/mark
```

可写回：

- `workflow_status`
- `tag`
- `note`
- `openai_password`

### 单条更新

```http
PUT /accounts/{email}
```

### 单条删除

```http
DELETE /accounts/{email}
```

### 批量删除

```http
POST /accounts/batch-delete
```

### 清空数据库

```http
POST /accounts/clear
```

注意：需要 `confirm_text = CLEAR`

## 2. 收码相关 / Code fetching APIs

### 按 CSV 账号引用收码

```http
POST /fetch-code
```

### 直接传邮箱收码

```http
POST /fetch-code-direct
```

这是扩展当前最常用的接口。

请求体示例：

```json
{
  "email": "demo@hotmail.com",
  "password": "replace-me",
  "client_id": "optional-client-id",
  "refresh_token": "optional-refresh-token",
  "access_method": "auto",
  "max_wait_seconds": 90,
  "poll_interval_seconds": 5,
  "min_created_at_ms": 0,
  "exclude_codes": []
}
```

### 直接传邮箱列邮件

```http
POST /messages-direct
```

返回结构与 `graph` 及 `/accounts/{email}/messages` 一致，适合不依赖本地 DB 时直接读取邮箱列表。

### 释放会话缓存

```http
POST /release-session
```

## 3. Microsoft OAuth helper

### 获取授权链接

```http
GET /oauth/auth-url
```

### 交换 token

```http
POST /oauth/exchange-token
```

支持两种输入：

```json
{ "callback_url": "http://localhost:8080/?code=..." }
```

或：

```json
{ "code": "authorization-code" }
```

---

## `access_method` 说明 / Access method guide

### `graph`

- 使用 Microsoft Graph API
- 需要 `client_id + refresh_token`
- 推荐作为稳定主链路

### `imap_new`

- 使用 `outlook.live.com` IMAP
- 需要 `client_id + refresh_token`

### `imap_old`

- 使用 `outlook.office365.com` IMAP
- 需要 `client_id + refresh_token`

### `playwright`

- 使用 Outlook Web 登录并抓取邮件
- 依赖邮箱密码
- 成功率受账号质量、风控状态和页面结构影响
- 更适合作为实验功能和继续开发入口

### `auto`

优先尝试 token 可用的路径，再回退到 Playwright。

---

## 导入格式 / Import format

扩展侧栏中的 `Batch` 可以直接导入到服务 DB，格式固定为：

```text
email----password----client_id----refresh_token
```

---

## 环境变量 / Environment variables

当前支持：

- `HOTMAIL_ACCOUNTS_CSV`
- `HOTMAIL_ACCOUNTS_DB`
- `HOTMAIL_ARTIFACTS_DIR`
- `HOTMAIL_SESSION_STATE_DIR`
- `HOTMAIL_HEADLESS`
- `HOTMAIL_OUTLOOK_URL`
- `HOTMAIL_LOGIN_TIMEOUT_SECONDS`
- `HOTMAIL_DEFAULT_MAX_WAIT_SECONDS`
- `HOTMAIL_DEFAULT_POLL_INTERVAL_SECONDS`
- `HOTMAIL_NAVIGATION_TIMEOUT_MS`
- `HOTMAIL_ACTION_TIMEOUT_MS`
- `HOTMAIL_SELECTOR_PROBE_TIMEOUT_MS`
- `HOTMAIL_POST_ACTION_WAIT_MS`
- `HOTMAIL_BROWSER_HEALTH_CACHE_SECONDS`
- `HOTMAIL_OAUTH_REDIRECT_URI`
- `HOTMAIL_OAUTH_CLIENT_ID`

常用默认值：

- `HOTMAIL_ACCOUNTS_DB = data/hotmail_accounts.db`
- `HOTMAIL_ARTIFACTS_DIR = output/playwright`
- `HOTMAIL_SESSION_STATE_DIR = output/playwright/sessions`
- `HOTMAIL_OAUTH_REDIRECT_URI = http://localhost:8080`

---

## 测试 / Testing

在 `hotmail-service` 目录下执行：

```powershell
python -m pytest
```

当前测试覆盖：

- 健康检查
- `/fetch-code` / `/fetch-code-direct`
- `/release-session`
- OAuth helper
- DB 导入 / 领取 / 标记 / 更新 / 删除 / 批量操作 / 清空
- 收件时间解析
- 多语言文件夹别名
- 结果排序与诊断上下文

---

## 调试产物 / Debug artifacts

失败时常见调试产物会写到：

```text
output/playwright/
```

包括：

- 截图
- trace
- console log
- session state

---

## 常见问题 / FAQ

### 1. `/health` 返回 degraded

优先检查：

- `accounts.csv` 是否可读
- Playwright Chromium 是否已安装
- 当前机器是否能正常启动 browser

### 2. 为什么优先推荐 token 方式

因为 Graph / IMAP 更稳定，更少依赖真实网页结构，也更少受登录页风控影响。

### 3. 只有邮箱密码能不能用

可以试 `playwright`，但当前属于实验链路。

### 4. 为什么服务一次只处理一个收码请求

当前服务通过锁避免并发混淆，目的是降低多账号同时收码时的干扰。

---

## 已知限制 / Known limitations

- Playwright 链路仍会受到 Outlook 页面变化影响
- 纯密码登录会受到账号质量和风控影响
- 服务需要手动提前启动

---

## 相关文档 / Related docs

- 仓库主文档：[`../README.md`](../README.md)
- 扩展说明：[`../multiPagePlugins/README.md`](../multiPagePlugins/README.md)
- API 集成说明：[`./API_INTEGRATION.md`](./API_INTEGRATION.md)
