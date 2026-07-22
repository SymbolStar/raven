# Raven CLI 快速启动

Raven CLI 用一条命令同时启动本地 Proxy 与 Dashboard，并在首次运行时自动
生成、持久化本地访问密钥。

```text
raven start --dev
  -> Proxy:     http://localhost:7025
  -> Dashboard: http://localhost:7023
```

## 安装

```bash
git clone https://github.com/SymbolStar/raven.git
cd raven
bun install
```

在仓库目录中可直接运行：

```bash
bun run cli start --dev
```

如需在任意目录运行一次安装全局命令：

```bash
bun link
```

之后使用：

```bash
raven start --dev
```

## 自动生成的密钥

首次启动会生成两把随机密钥，并仅以当前用户权限保存到：

```text
macOS: ~/Library/Application Support/raven/gateway.json
Linux: ~/.config/raven/gateway.json
```

后续启动复用同一组密钥，因此 Claude Code 等客户端的配置不会因为 Raven
重启而改变。该文件包含本地密钥，不应提交到 Git 或分享给其他人。

### 从手动启动迁移

如果此前一直手动设置 `RAVEN_API_KEY` 和 `RAVEN_INTERNAL_KEY`，第一次使用
CLI 时可明确传入原有两把 key。这样现有 Claude Code 和 Dashboard 配置保持
不变：

```bash
RAVEN_API_KEY='已有客户端 key' \
RAVEN_INTERNAL_KEY='已有 Dashboard key' \
raven start --dev
```

这不会修改 Raven 的 SQLite 数据库、已添加的 Provider 或 CarHer API Key。
两把 key 必须同时提供；之后如需让 CLI 自动持久化它们，可将相同内容写入
`gateway.json`。

## 启动模式

```bash
# Dashboard 开发模式，适合本地首次使用和开发
raven start --dev

# Dashboard 生产模式；首次运行前先构建一次
bun run build
raven start
```

可通过环境变量调整端口：

```bash
RAVEN_PORT=8125 RAVEN_DASHBOARD_PORT=8123 raven start --dev
```

按 `Ctrl+C` 会同时停止 Proxy 和 Dashboard。

## 下一步

1. 打开 `http://localhost:7023`。
2. 进入 **Settings -> Upstreams**，添加 CarHer 或其他 Provider。
3. 将 AI 客户端的 Base URL 指向 `http://localhost:7025`。
4. 使用 `gateway.json` 中的 `apiKey` 作为 AI 客户端访问 Raven 的 key；
   `internalKey` 仅供 Dashboard 内部管理请求使用。
