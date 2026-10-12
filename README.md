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
node bin/wb-connect.js --help
```

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

```bash
wb-connect install
```

这会将 `workbuddy` 和 `workbuddy-ai` 两个 provider 写入 OpenCode 的配置文件（OpenChamber 会自动检测 `OPENCODE_CONFIG` 环境变量）。写入后重启 OpenCode / OpenChamber，模型选择器中即出现 WorkBuddy 与 WorkBuddy AI 分组。

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
