# hotmail_re_plugin

> Hotmail-enhanced OpenAI / ChatGPT OAuth automation workflow  
> 基于社区已有 fork 继续增强的版本：把 Chrome 扩展自动化流程与本地 Hotmail companion service 组合在一起，用于批量跑注册、收码、OAuth 回调与 CPA 验证。

---

## 项目来源 / Project Lineage

这个项目不是从零开始的新工程，而是在已有工作的基础上继续往下补的版本。

- 原始上游仓库：<https://github.com/QLHazyCoder/codex-oauth-automation-extension>
- 相关帖子：<https://linux.do/t/topic/1928372>
- 当前这个版本，是在另一个 fork 分支基础上继续改进的，相关帖子：<https://linux.do/t/topic/1914073>
- Hotmail 能力参考项目：<https://github.com/ZeroPointSix/outlookEmailPlus>

### 这版主要补了什么 / What this fork adds

1. **拆出本地 `hotmail-service`**  
   把 Hotmail / Outlook 收码逻辑从扩展运行时中拆出来，改成独立本地服务。
2. **支持 Hotmail 批量账号数据库调度**  
   账号导入后进入 SQLite，本地按 `pending -> claimed -> success / failed` 生命周期流转。
3. **支持 Graph / IMAP / Playwright 多收码链路**  
   当前支持：
   - `graph`
   - `imap_new`
   - `imap_old`
   - `playwright`
   - `auto`
4. **补了 WebUI 和基础管理能力**  
   可以直接查看 Hotmail 账号池、状态汇总、批量更新和清理。
5. **保留了纯账号密码链路的实验入口**  
   `playwright` 方式可以尝试只有账号密码的 Hotmail 收码，但目前仍然更适合作为实验功能和后续开发基础。

---

## 项目结果 / What this project does now

从当前代码实现来看，这已经不是单一扩展，而是一个 **双组件协作系统**：

- **Chrome Extension (`multiPagePlugins`)**  
  负责侧栏 UI、Step 1 ~ 9 自动化、页面注入、注册页 / OAuth 页面操作，以及 CPA API 对接。
- **Hotmail Companion Service (`hotmail-service`)**  
  负责 Hotmail / Outlook 收码、OAuth helper、本地 SQLite 账号库、批量状态管理，以及 WebUI 管理页面。

### 当前已经实现的能力 / Current implemented capabilities

#### 1. OAuth 链接获取改为 CPA API

当前 Step 1 与 Step 9 不再依赖旧式页面 DOM，而是直接走：

- `GET /v0/management/codex-auth-url?is_webui=true`
- `POST /v0/management/oauth-callback`
- `GET /v0/management/get-auth-status?state=...`

#### 2. Hotmail 改为本地服务收码

扩展在 Hotmail 模式下，主要调用本地：

- `GET /health`
- `POST /fetch-code-direct`
- `POST /accounts/import`
- `GET /accounts/summary`
- `POST /accounts/claim-next`
- `POST /accounts/mark`
- `POST /accounts/reset-claimed`

#### 3. Hotmail 批量账号改为数据库驱动

数据库默认位置：

```text
hotmail-service/data/hotmail_accounts.db
```

状态流转：

- `pending`
- `claimed`
- `success`
- `failed`

#### 4. 自带 Hotmail DB WebUI

服务内置：

```text
http://127.0.0.1:8001/accounts/ui
```

支持：

- 查看账号列表
- 按状态筛选
- 单条编辑状态 / 标签 / 备注 / OpenAI 密码
- 批量更新
- 批量删除
- 清空数据库
- 重置 `claimed`

#### 5. Hotmail 多链路取码

`/fetch-code-direct` 当前支持：

- `auto`
- `playwright`
- `graph`
- `imap_new`
- `imap_old`

推荐使用方式：

- 有 `client_id + refresh_token`：优先 `graph` / `imap`
- 只有邮箱密码：可尝试 `playwright`，但视为实验功能

---

## 架构总览 / Architecture

```text
.
├─ README.md
├─ multiPagePlugins/              # Chrome 扩展主体
│  ├─ background.js               # Step 1~9 主流程、状态管理、API 调用
│  ├─ manifest.json               # MV3 扩展清单
│  ├─ sidepanel/                  # 侧栏 UI
│  ├─ shared/                     # provider / oauth / verification 公共逻辑
│  ├─ content/                    # 页面自动化 content scripts
│  └─ data/
└─ hotmail-service/               # 本地 FastAPI companion service
   ├─ app/
   │  ├─ main.py                  # FastAPI 入口与 API
   │  ├─ account_db.py            # SQLite 账号库
   │  ├─ outlook_client.py        # Playwright 收码逻辑
   │  ├─ oauth_mail_client.py     # Graph / IMAP / OAuth helper
   │  ├─ models.py                # API 请求/响应模型
   │  ├─ accounts.py              # CSV 账号加载
   │  ├─ config.py                # 环境变量配置
   │  └─ session_cache.py         # 会话缓存
   ├─ tests/
   ├─ requirements.txt
   ├─ start_hotmail_service.ps1
   └─ API_INTEGRATION.md
```

### 职责边界 / Responsibilities

| 组件 | 职责 |
| --- | --- |
| `multiPagePlugins` | UI、流程控制、页面自动化、邮箱来源切换、CPA API 调用 |
| `hotmail-service` | Hotmail 收码、账号 DB、WebUI、OAuth helper、会话缓存 |

---

## 前置条件 / Prerequisites

### 必需条件 / Required

- Google Chrome
- Python 3
- 可用的 CPA 地址与 Key
- 已克隆本仓库

### Hotmail 模式额外要求 / Extra requirements for Hotmail mode

#### 稳定主链路：Graph / IMAP

建议准备：

- `email`
- `password`
- `client_id`
- `refresh_token`

#### 实验链路：Playwright 纯密码

如果你只有：

- `email`
- `password`

也可以尝试 `playwright`，但当前更适合作为实验链路。

---

## 部署流程 / Deployment

推荐按下面顺序来：

1. 启动 `hotmail-service`
2. 加载 Chrome 扩展
3. 配置 CPA
4. 选择邮箱来源与收码方式
5. 先单步验证，再跑自动任务

### 1）启动 Hotmail companion service

在仓库根目录执行：

```powershell
powershell -ExecutionPolicy Bypass -File ".\hotmail-service\start_hotmail_service.ps1"
```

手动方式：

```powershell
cd .\hotmail-service
pip install -r requirements.txt
python -m playwright install chromium
uvicorn app.main:app --host 127.0.0.1 --port 8001
```

默认地址：

```text
http://127.0.0.1:8001
```

### 2）验证服务状态

打开：

```text
http://127.0.0.1:8001/health
```

扩展侧栏中也会显示 `Service` 状态：

- 绿色：Online
- 红色：Offline
- 橙色：Checking

### 3）加载 Chrome 扩展

1. 打开 `chrome://extensions/`
2. 开启开发者模式
3. 点击 **Load unpacked**
4. 选择：

```text
./multiPagePlugins
```

---

## 使用说明 / Usage

### 1. 侧栏主要字段 / Main side panel fields

当前侧栏中最关键的配置项有：

- `CPA`
- `CPA Key`
- `Source`
- `Mail`
- `Hotmail API`
- `Service`
- `Open WebUI`
- `Copy Start Cmd`
- `Batch`
- `Import to DB`
- `Refresh DB Summary`
- `Email`
- `Password`
- `Auto`
- `Stop`

### 2. 配置 CPA

先填写：

- `CPA`
- `CPA Key`

然后点击：

- `Save`

作用：

- Step 1 获取 OAuth URL
- Step 9 上报 callback 并确认最终认证状态

### 3. 选择邮箱来源 / Source

当前支持：

- `mail_2925`
- `hotmail`
- `duckduckgo`
- `cloudflare_temp_email`
- `relay_firefox`

### 4. 选择收码来源 / Mail

当前支持：

- `2925`
- `cloudflare_temp_email`
- `hotmail`
- `163`
- `qq`
- `inbucket`

### 5. Hotmail 模式

当 `Source = hotmail` 时：

- `Mail` 会自动绑定为 `hotmail`
- 扩展优先从 DB 领取账号
- `Hotmail API` 默认使用：

```text
http://127.0.0.1:8001
```

- 可通过 `Open WebUI` 直接打开账号管理页

### 6. Hotmail 批量导入格式

`Batch` 中每行一个账号：

```text
email----password----client_id----refresh_token
```

导入步骤：

1. 粘贴到 `Batch`
2. 点击 `Import to DB`
3. 点击 `Refresh DB Summary`
4. 确认 `pending` 数量正常

### 7. 单步运行

第一次建议先验证：

1. Step 1 `Get OAuth Link`
2. Step 2 `Open Signup`
3. Step 3 `Fill Email / Password`
4. Step 4 `Get Signup Code`

### 8. 自动运行

点击 `Auto` 后，扩展会顺序执行 Step 1 ~ 9。

在 Hotmail 模式下，每轮大致流程：

1. 领取下一条 `pending`
2. 标记为 `claimed`
3. 执行主流程
4. 成功后写回 `success`
5. 失败后写回 `failed`
6. 继续下一条账号

---

## 功能介绍 / Features

### 1. 9 步自动化流程

1. `Get OAuth Link`
2. `Open Signup`
3. `Fill Email / Password`
4. `Get Signup Code`
5. `Fill Name / Birthday`
6. `Login via OAuth`
7. `Get Login Code`
8. `OAuth Auto Confirm`
9. `CPA Verify`

### 2. 多邮箱来源支持

支持 2925、Hotmail、DuckDuckGo、Cloudflare Temp Email、Firefox Relay。

### 3. Hotmail 批量工作流

支持批量导入、DB 状态汇总、自动领取账号、自动回写结果。

### 4. WebUI 管理

支持查看、编辑、批量更新、删除和清库。

### 5. 本地状态持久化

扩展会持久化保存 CPA 与 Hotmail 基础设置，并在 session 中保存运行状态。

---

## 模块说明 / Module Guide

### 扩展部分 / Extension

- `multiPagePlugins/background.js`：主流程控制、状态管理、API 调用
- `multiPagePlugins/sidepanel/`：侧栏 UI 和交互逻辑
- `multiPagePlugins/shared/`：公共逻辑
- `multiPagePlugins/content/`：各页面 content scripts

### 服务部分 / Service

- `hotmail-service/app/main.py`：FastAPI 入口
- `hotmail-service/app/account_db.py`：SQLite 账号库
- `hotmail-service/app/outlook_client.py`：Playwright 收码逻辑
- `hotmail-service/app/oauth_mail_client.py`：Graph / IMAP / OAuth helper
- `hotmail-service/app/models.py`：API 模型

---

## 项目流程 / Workflow

### 主流程 / Main automation flow

#### Step 1 — Get OAuth Link

调用：

```http
GET /v0/management/codex-auth-url?is_webui=true
```

#### Step 2 — Open Signup

打开注册页并准备自动化操作。

#### Step 3 — Fill Email / Password

在 Hotmail 模式下，邮箱优先来自 DB 领取账号。

#### Step 4 — Get Signup Code

普通邮箱继续使用原 content script 逻辑；Hotmail 调用 `/fetch-code-direct`。

#### Step 5 — Fill Name / Birthday

自动填充页面信息。

#### Step 6 — Login via OAuth

进入 OAuth 登录链路。

#### Step 7 — Get Login Code

再次获取登录验证码，Hotmail 模式同样通过本地服务。

#### Step 8 — OAuth Auto Confirm

自动处理授权页与本地回调。这一步目前最容易受页面变化影响。

#### Step 9 — CPA Verify

调用：

```http
POST /v0/management/oauth-callback
GET  /v0/management/get-auth-status?state=...
```

### Hotmail DB 驱动流程 / Hotmail DB-driven flow

1. 检查 service 健康状态
2. 清理 stale `claimed`
3. 领取下一条 `pending`
4. 执行主流程
5. 写回 `success` 或 `failed`
6. 继续下一轮

---

## Service API 概览 / Service API Overview

### 健康检查

```http
GET /health
```

### 账号数据库

```http
POST /accounts/import
GET  /accounts/summary
GET  /accounts
GET  /accounts/ui
POST /accounts/batch-update
POST /accounts/reset-claimed
POST /accounts/claim-next
POST /accounts/mark
PUT  /accounts/{email}
DELETE /accounts/{email}
POST /accounts/batch-delete
POST /accounts/clear
```

### 收码接口

```http
POST /fetch-code
POST /fetch-code-direct
POST /release-session
```

### Microsoft OAuth helper

```http
GET  /oauth/auth-url
POST /oauth/exchange-token
```

---

## 测试与校验 / Testing

### 扩展脚本语法检查

```powershell
node --check .\multiPagePlugins\background.js
node --check .\multiPagePlugins\sidepanel\sidepanel.js
```

### Hotmail service 测试

```powershell
cd .\hotmail-service
python -m pytest
```

---

## 常见问题 / FAQ

### 1. Service 一直是 Offline

优先检查：

- `hotmail-service` 是否运行在 `127.0.0.1:8001`
- `Hotmail API` 是否填写正确
- `http://127.0.0.1:8001/health` 是否能打开
- Playwright Chromium 是否已安装

### 2. Import to DB 后数量不对

先确认导入格式是否正确：

```text
email----password----client_id----refresh_token
```

### 3. 没有 pending 账号

说明当前数据库中已经没有可用的 `pending`。

### 4. Step 4 / Step 7 取码失败

建议优先检查：

- `access_method` 是否合理
- `client_id + refresh_token` 是否有效
- 当前账号质量是否过差

### 5. Step 8 为什么最容易失败

因为它最依赖真实授权页结构、点击定位和 localhost callback。

---

## 实验功能与限制 / Experimental Features & Limitations

### 实验功能

**只有账号密码的 Playwright 收码** 当前保留为实验功能。

建议定位为：

- 有一定成功率
- 和账号质量关系很大
- 尚未充分验证稳定性
- 更适合作为继续开发基础

### 已知限制

- Step 8 容易受页面变化影响
- `hotmail-service` 需要用户自己先启动
- Hotmail 模式下数据源以 DB 为准
- Playwright 链路会受风控与页面变化影响

---

## 相关文档 / Related Docs

- 扩展说明：[`multiPagePlugins/README.md`](./multiPagePlugins/README.md)
- 服务说明：[`hotmail-service/README.md`](./hotmail-service/README.md)
- API 集成说明：[`hotmail-service/API_INTEGRATION.md`](./hotmail-service/API_INTEGRATION.md)
