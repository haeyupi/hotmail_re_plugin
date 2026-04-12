# multiPagePlugins

> Chrome extension for the Step 1 ~ 9 automation flow  
> 仓库中的扩展主体，负责侧栏 UI、流程编排、页面自动化，以及与 CPA API / Hotmail companion service 的对接。

如果你还没看过仓库主文档，建议先读：[`../README.md`](../README.md)

---

## 这个目录是做什么的 / What this directory does

`multiPagePlugins` 是整个项目的前台控制层。它负责：

- Chrome 侧栏 UI
- Step 1 ~ 9 自动化主流程
- content scripts 注入和页面操作
- CPA API 调用
- Hotmail service API 调用

也就是说：

- **扩展**负责流程控制
- **`hotmail-service`** 负责 Hotmail 收码和账号池能力

---

## 当前能力 / Current capabilities

### 1. 9 步自动化

1. `Get OAuth Link`
2. `Open Signup`
3. `Fill Email / Password`
4. `Get Signup Code`
5. `Fill Name / Birthday`
6. `Login via OAuth`
7. `Get Login Code`
8. `OAuth Auto Confirm`
9. `CPA Verify`

### 2. 支持多种注册邮箱来源 / Email sources

`Source` 当前支持：

- `mail_2925`
- `hotmail`
- `duckduckgo`
- `cloudflare_temp_email`
- `relay_firefox`

### 3. 支持多种验证码来源 / Mail providers

`Mail` 当前支持：

- `2925`
- `cloudflare_temp_email`
- `hotmail`
- `163`
- `qq`
- `inbucket`

### 4. 支持 CPA API 模式

当前版本关键接口：

- `GET /v0/management/codex-auth-url?is_webui=true`
- `POST /v0/management/oauth-callback`
- `GET /v0/management/get-auth-status?state=...`

### 5. 支持 Hotmail DB 驱动批量任务

当 `Source = hotmail` 时，扩展会：

- 连接本地 `hotmail-service`
- 领取下一条 `pending`
- 运行完成后写回 `success` / `failed`
- 在 Auto 模式下持续消费账号池

### 6. 侧栏内置 Hotmail 状态与 DB 操作入口

当前可直接在侧栏看到：

- `Hotmail API`
- `Service`
- `Open WebUI`
- `Copy Start Cmd`
- `Batch`
- `Import to DB`
- `Refresh DB Summary`

---

## 目录结构 / Structure

```text
multiPagePlugins/
├─ background.js
├─ manifest.json
├─ sidepanel/
│  ├─ sidepanel.html
│  ├─ sidepanel.js
│  └─ sidepanel.css
├─ shared/
│  ├─ email-provider.js
│  ├─ oauth-flow.js
│  ├─ verification-flow.js
│  ├─ dynamic-injection.js
│  ├─ mail-2925.js
│  ├─ qq-mail.js
│  └─ cloudflare-temp-email.js
├─ content/
│  ├─ signup-page.js
│  ├─ utils.js
│  ├─ 2925-mail.js
│  ├─ qq-mail.js
│  ├─ mail-163.js
│  ├─ inbucket-mail.js
│  ├─ duck-mail.js
│  ├─ relay-firefox.js
│  ├─ cloudflare-temp-email.js
│  └─ vps-panel.js
├─ data/
└─ icons/
```

---

## 关键模块 / Key modules

### `manifest.json`

当前扩展为 **Manifest V3**。

主要权限包括：

- `sidePanel`
- `tabs`
- `webNavigation`
- `debugger`
- `storage`
- `scripting`
- `activeTab`

### `background.js`

这是扩展核心控制器，负责：

- 默认状态管理
- `chrome.storage.local` / `chrome.storage.session` 同步
- Step 1 ~ 9 执行与等待
- CPA API 调用
- Hotmail service API 调用
- Auto Run 循环
- Stop / timeout / error recovery
- 当前 Hotmail DB 账号的领取与写回

### `sidepanel/sidepanel.html`

定义侧栏页面结构，包括：

- CPA 区
- Source / Mail 选择区
- Hotmail 配置区
- Batch 导入区
- Workflow Step 列表
- Console 日志区

### `sidepanel/sidepanel.js`

负责侧栏交互：

- 恢复上次输入
- 更新状态栏与步骤状态
- 切换 Hotmail 配置显示逻辑
- 刷新 service 状态
- 展示 DB summary
- 向 `background.js` 发送消息

### `shared/email-provider.js`

集中管理 provider 常量和归一化逻辑，例如：

- `normalizeEmailProvider`
- `isHotmailEmailProvider`
- `normalizeHotmailApiBaseUrl`

### `content/signup-page.js`

负责注册 / 登录 / 填码等页面自动化，是主链路中最关键的 content script 之一。

---

## 侧栏说明 / Side panel guide

### CPA 区

- `CPA`
- `CPA Key`
- `Save`

作用：

- Step 1 获取 OAuth URL
- Step 9 上报 callback 并确认最终状态

### Source / Mail

- `Source` 决定注册邮箱来源
- `Mail` 决定验证码获取来源

### Hotmail 字段

当 `Source = hotmail` 时，侧栏会显示或启用：

- `Hotmail API`
- `Service`
- `Current`
- `Hotmail Email`
- `Hotmail Password`
- `Hotmail Access`
- `Client ID`
- `Refresh Token`
- `Batch`

其中 `Hotmail Access` 支持：

- `auto`
- `graph`
- `imap_new`
- `imap_old`
- `playwright`

### Hotmail 模式的特点

- 扩展优先从 DB 领取账号
- 普通 `Email` / `Password` 不再是主数据源
- 当前实际运行账号以 DB 领取结果为准

---

## 运行方式 / How to run

### 1. 在 Chrome 中加载扩展

1. 打开 `chrome://extensions/`
2. 开启开发者模式
3. 点击 **Load unpacked**
4. 选择：

```text
./multiPagePlugins
```

### 2. 使用 Hotmail 模式前先启动服务

扩展不会直接拉起 Python 进程。你需要先启动：

```text
./hotmail-service
```

默认地址：

```text
http://127.0.0.1:8001
```

### 3. 推荐首次使用顺序

1. 配置 `CPA` / `CPA Key`
2. 选择邮箱来源
3. 如果是 Hotmail，先确认 `Service` Online
4. 先跑 Step 1 ~ 4
5. 确认收码稳定后再用 `Auto`

---

## Hotmail 批量模式 / Hotmail batch mode

### 导入格式

```text
email----password----client_id----refresh_token
```

### DB 状态生命周期

- `pending`
- `claimed`
- `success`
- `failed`

### Auto 行为

当你点击 `Auto`，且当前为 Hotmail 模式时：

1. 检查 service 健康状态
2. 清理 stale `claimed`
3. 领取下一条 `pending`
4. 执行 Step 1 ~ 9
5. 成功则写回 `success`
6. 失败则写回 `failed`
7. 继续下一条账号

---

## 调试与检查 / Debugging and checks

### 语法检查

```powershell
node --check .\multiPagePlugins\background.js
node --check .\multiPagePlugins\sidepanel\sidepanel.js
```

### 常见排查方向

- Step 1 失败：先看 `CPA` / `CPA Key`
- Step 4 / Step 7 失败：看收码链路是否稳定
- Hotmail 模式失败：先看 `Service` 是否在线、DB 是否有 `pending`
- Step 8 失败：看授权页结构和 localhost callback

---

## 已知限制 / Known limitations

- Step 8 仍然最容易受页面变化影响
- 扩展不会直接启动 Python service
- Hotmail 批量模式下以 DB 为准，不以单条 UI 输入为准
- Playwright 纯密码取码属于实验链路

---

## 相关文档 / Related docs

- 仓库主文档：[`../README.md`](../README.md)
- Hotmail service 文档：[`../hotmail-service/README.md`](../hotmail-service/README.md)
- Hotmail API 说明：[`../hotmail-service/API_INTEGRATION.md`](../hotmail-service/API_INTEGRATION.md)
