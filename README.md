# oc-workbuddy-connect

将 WorkBuddy 桌面 App 中的模型（国内版 WorkBuddy 与国际版 WorkBuddy AI）通过本地 OpenAI 兼容桥接入 OpenCode / OpenChamber，零运行时依赖，可复用、可发布、可移植。

## 功能

- **双产品同时服务**：国内版 WorkBuddy（`copilot.tencent.com`）与国际版 WorkBuddy AI（`www.workbuddy.ai`）由一个进程同时服务，各自使用自己的账号与积分。
- **OpenAI 兼容端点**：`GET /v1/models`、`POST /v1/chat/completions`、`GET /healthz`，任何 OpenAI 兼容客户端均可直接接入。
- **流式与非流式**：上游只接受流式请求，桥对非流式客户端自动缓冲并合并为完整响应。
- **工具调用**：完整支持 `tool_calls` / `function_call` 两种上游拼写。
- **推理内容**：`reasoning_content` 与 `reasoning` 双字段保留。
- **推理档位**：上游声明的 `supportedEfforts` 自动生成为 OpenCode 的 effort variants。
- **凭据自动解密**：WorkBuddy 5.6+ 的 at-rest 加密凭据通过 App 自身的 Electron 二进制解密，无需用户干预。
- **令牌自动刷新**：access token 过期前自动刷新，刷新后的凭据存储在桥自有目录，不写桌面 App 的文件。
- **模型目录缓存**：上游不可达时降级为上次成功目录，并标注来源与警告。
- **积分查询**：实时读取剩余积分，支持国内版企业账号。
- **API Key 认证**：可选 bearer token 保护本地端点。
- **OpenCode 配置生成**：`install` 命令自动将 provider 写入 OpenCode / OpenChamber 配置文件。

## 前置条件

- Node.js >= 20.6
- 已安装并登录 WorkBuddy 或 WorkBuddy AI 桌面 App（至少一个）

## 安装

```bash
npm install -g oc-workbuddy-connect
```

或从源码运行：

```bash
git clone https://github.com/your-org/oc-workbuddy-connect.git
cd oc-workbuddy-connect
npm link              # 注册全局 wb-connect 命令
wb-connect --help
```

`npm link` 会把全局命令链接到源码目录（本项目零运行时依赖，不会安装额外包）。如果不想注册全局命令，也可以直接用 `node bin/wb-connect.js <命令>` 调用，后文所有 `wb-connect xxx` 均等价于 `node bin/wb-connect.js xxx`。

## 快速开始

### 1. 启动桥

```bash
wb-connect serve --port 8787
```

输出：

```
wb-connect listening on http://127.0.0.1:8787/v1
  products : workbuddy, workbuddy-ai
  routing  : set the x-workbuddy-variant header, or prefix the model id as <variant>/<model>
  routes   : GET /v1/models - POST /v1/chat/completions - GET /healthz
```

### 2. 配置 OpenCode / OpenChamber

有两种等价方式，**任选其一**，二者写入的是同一份 provider 配置。

#### 方式 A：命令行（推荐）

```bash
wb-connect install
```

这会将 `workbuddy` 和 `workbuddy-ai` 两个 provider 写入 OpenCode 的配置文件（OpenChamber 会自动检测 `OPENCODE_CONFIG` 环境变量）。写入后重启 OpenCode / OpenChamber，模型选择器中即出现 WorkBuddy 与 WorkBuddy AI 分组。

#### 方式 B：OpenChamber 界面

不想敲命令时，可以在 OpenChamber 里手动添加。路径：**设置 → 提供商 → 自定义提供商**。

依次添加两个 provider，字段值如下。

**第一个：**

| 字段 | 值 |
|------|-----|
| 提供商 ID | `workbuddy` |
| 显示名称 | `WorkBuddy` |
| API 协议 | **OpenAI Chat Completions** |
| 基础 URL | `http://127.0.0.1:8787/v1` |
| API 密钥 | 桥的 `--api-key` 值；桥未设密钥时填任意非空占位值 |
| 请求头 | `x-workbuddy-variant` = `workbuddy` |

**第二个：**

| 字段 | 值 |
|------|-----|
| 提供商 ID | `workbuddy-ai` |
| 显示名称 | `WorkBuddy AI` |
| API 协议 | **OpenAI Chat Completions** |
| 基础 URL | `http://127.0.0.1:8787/v1` |
| API 密钥 | 同上 |
| 请求头 | `x-workbuddy-variant` = `workbuddy-ai` |

模型列表可以点击界面里的「查找模型」自动拉取，也可以手动填写。若「查找模型」拉到的列表把两个产品的模型混在了一起，改用模型 ID 前缀写法即可区分：

```
workbuddy/<model>       例如 workbuddy/claude-sonnet-4
workbuddy-ai/<model>    例如 workbuddy-ai/kimi-k3
```

> **请求头不能省。** 桥靠 `x-workbuddy-variant` 判断请求属于国内版还是国际版；不带该请求头时，桥无法确定产品，请求会失败。两个 provider 共用同一个地址、同一个端口，仅靠这个请求头分流。

> **前提：桥必须已在运行。** 方式 A 与方式 B 都只是写入配置，不会启动桥。若 `wb-connect serve` 没在跑，配置再正确，模型列表也是空的，调用会报 `provider.auth` 错误。见下一节「服务保持」。

### 3. 验证

```bash
wb-connect doctor
```

输出示例：

```
WorkBuddy  (workbuddy)
  auth file : C:\Users\you\AppData\Local\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info
  sign-in   : ok (token until 2026-11-09 08:19:40 UTC; from desktop app)
  identity  : WorkBuddy/5.7.7
  catalog   : 18 models from upstream
  credits   : 430

WorkBuddy AI  (workbuddy-ai)
  auth file : C:\Users\you\AppData\Local\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop-ai.info
  sign-in   : ok (token until 2027-10-12 04:40:11 UTC; from desktop app)
  identity  : WorkBuddy AI/5.7.6
  catalog   : 27 models from upstream
  credits   : 146

2 of 2 products ready.
```

## 服务保持（开机自启）

桥是一个常驻的本地 HTTP 进程。**OpenChamber 不会自动拉起它**——provider 配置里只有地址，没有进程管理能力。因此以下情况都会导致模型不可用，报错通常表现为 `provider.auth` 或连接失败：

- 关闭了运行 `wb-connect serve` 的终端窗口
- 重启了 OpenChamber，但桥仍是上一次的进程
- 重启了电脑

最小成本的解决方式是把桥放进开机启动文件夹（下称 **D2 方案**），登录 Windows 后自动以后台方式运行。

### 前置：装好全局命令

自启项指向全局命令 `%APPDATA%\npm\wb-connect.cmd`，因此需要先注册（作用见「安装」一节）：

```bash
cd <项目目录>
npm link
```

### 创建启动项

在项目目录下执行（把 `<项目目录>` 换成实际路径）：

```powershell
$projectDir = "<项目目录>"
$startup = [Environment]::GetFolderPath('Startup')
$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut("$startup\wb-connect.lnk")
$lnk.TargetPath       = "$env:APPDATA\npm\wb-connect.cmd"
$lnk.Arguments        = "serve --port 8787"
$lnk.WorkingDirectory = $projectDir
$lnk.WindowStyle      = 7          # 7 = 最小化，避免遮挡桌面
$lnk.Description      = "WorkBuddy bridge for OpenCode / OpenChamber"
$lnk.Save()
```

`WindowStyle = 7` 让窗口以最小化方式启动。注意快捷方式**不会**完全隐藏窗口，任务栏仍会有一个最小化图标；这是 D2 方案相对后台服务的取舍。

### 验证

注销并重新登录 Windows（或直接双击刚生成的快捷方式），然后：

```powershell
Invoke-RestMethod http://127.0.0.1:8787/healthz
```

返回中包含 `"status": "ok"` 即表示桥已随登录启动：

```json
{
  "status": "ok",
  "variants": {
    "workbuddy":    { "state": "signed-in", "domain": "www.workbuddy.cn" },
    "workbuddy-ai": { "state": "signed-in", "domain": "www.workbuddy.ai" }
  }
}
```

也可以用 `wb-connect doctor` 一并检查登录状态与模型目录。

### 移除自启

```powershell
Remove-Item "$([Environment]::GetFolderPath('Startup'))\wb-connect.lnk"
```

### 其他平台

macOS 与 Linux 没有等价的启动文件夹。若需要这两个平台的常驻方案，请使用系统自带的服务管理器（macOS 用 `launchd` 的 `LaunchAgent`，Linux 用 `systemd --user`）。**这些配置本仓库未做实测**，请自行验证。

## 命令参考

### `serve`

运行 OpenAI 兼容桥。

| 选项 | 说明 |
|------|------|
| `--port <n>` | 监听端口（默认 8787） |
| `--host <addr>` | 绑定地址（默认 127.0.0.1） |
| `--api-key <key>` | 要求 bearer token 认证 |
| `--variant <id>` | 仅服务指定产品 |

### `doctor`

诊断登录状态、at-rest 密钥助手、模型目录与积分。

### `models`

列出模型目录。`--refresh` 绕过缓存。

### `credits`

显示剩余积分。

### `chat`

运行一次非交互式完成，用于冒烟测试。

| 选项 | 说明 |
|------|------|
| `--model <id>` | 模型 ID（必需） |
| `--prompt <text>` | 提示文本 |
| `--variant <id>` | 指定产品 |
| `--tools` | 请求工具调用 |

### `install`

将 provider 写入 OpenCode / OpenChamber 配置。

| 选项 | 说明 |
|------|------|
| `--config <path>` | 目标配置文件 |
| `--port <n>` | 桥端口 |
| `--api-key <key>` | 写入配置的 bearer token |
| `--default-model <m>` | 同时设置默认模型 |
| `--dry-run` | 打印结果不写入 |

### `uninstall`

从配置文件中移除 WorkBuddy provider。

### `logout`

清除桥自有的凭据副本（不动桌面 App 的登录状态）。

## 环境变量

| 变量 | 说明 |
|------|------|
| `WORKBUDDY_AUTH_FILE` | 覆盖国内版 auth 文件路径 |
| `WORKBUDDY_AI_AUTH_FILE` | 覆盖国际版 auth 文件路径 |
| `WORKBUDDY_ELECTRON_BIN` | 显式指定国内版 Electron 二进制 |
| `WORKBUDDY_AI_ELECTRON_BIN` | 显式指定国际版 Electron 二进制 |
| `WORKBUDDY_CONNECT_CACHE_DIR` | 桥自有状态目录 |
| `WB_CONNECT_API_KEY` | 桥要求的 bearer token |
| `OPENCODE_CONFIG` | OpenCode 配置文件路径（OpenChamber 自动设置） |

## 架构

```
src/
├── variants.js          # 两个产品的描述符（ID、上游地址、Electron 配置）
├── at-rest.js           # WorkBuddy 5.6 at-rest 加密：AAD 构建、信封解密
├── electron.js          # Electron 二进制发现与密钥助手调用
├── credentials.js       # 凭据读取、解密、刷新、缓存
├── upstream.js          # 上游 HTTP 客户端：chat、catalog、credits、refresh
├── catalog.js           # 模型目录规范化与促销应用
├── chat-body.js         # OpenAI 请求体规范化
├── sse.js               # SSE 流解析与合并
├── session.js           # 单产品会话：凭据 + 目录 + 积分
├── server.js            # OpenAI 兼容 HTTP 服务器
├── opencode-config.js   # OpenCode 配置读写
├── cli.js               # 命令行入口
└── index.js             # 库导出
```

## 安全

- **凭据只读**：桥从不写入桌面 App 的 auth 文件。
- **密钥内存驻留**：at-rest  protector key 仅在进程内存中缓存，从不落盘。
- **API Key 认证**：`--api-key` 启用后，所有请求必须携带正确的 bearer token。
- **常量时间比较**：API key 验证使用 `timingSafeEqual`，不泄露时序信息。
- **请求体大小限制**：32 MB 上限，防止内存耗尽。

## 已知限制

- **上游依赖**：WorkBuddy 客户端接口为非官方 API，App 更新后可能需要适配。
- **国际版目录**：国际版模型目录来自 App 界面接口，服务端按 User-Agent 分流，属私有实现。
- **Linux 无自动发现**：Linux 上 Electron 二进制需通过环境变量显式指定。
- **企业账号**：企业账号积分目前仅覆盖国内版。
- **推理档位**：未声明档位的模型使用上游默认档位，不主动探测。

## 测试

```bash
npm test
```

61 个单元测试覆盖 at-rest 加密、chat-body 规范化、目录解析、SSE 合并、OpenCode 配置生成与变体解析。

## 许可证

MIT
