# DSH Hub

在浏览器里使用 HPC 上的 DeepSeek Harness。公网机器跑 Hub；HPC 只出站连接，不开放入站端口。

```text
浏览器  ──HTTPS──▶  Hub（公网，TLS 反代）  ◀──WSS（出站）──  Agent + dsh（HPC）
```

两台机器都需要 Node.js >= 22.19，以及本仓库。HPC 上还要能运行 `dsh`。

```sh
node -v
```

安装完成后，命令是 `dsh-hub`，不需要 `npx`。

## 1. 安装

两台机器都执行：

```sh
git clone git@github.com:ZhimingYe/dsh-hub.git
cd dsh-hub
npm install
npm install -g .
```

确认命令已在 `PATH` 中：

```sh
dsh-hub --help
```

以后升级代码再执行一次 `npm install -g .`。
不装到系统时，在仓库根目录用 `npx dsh-hub`。

HPC 上确认 `dsh` 可用：

```sh
dsh --help
```

若没有全局 `dsh`，另装 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，在其仓库根目录执行 `pnpm install && pnpm run build`，再保证 `dsh` 在 `PATH` 中。

## 2. 启动 Hub

在公网机器上：

```sh
dsh-hub serve --user alice
```

按提示输入密码（不回显）。首次运行会在当前目录写入 `hub.yaml`（权限 `0600`）。成功后终端打印：

```text
config: /home/you/deepseek-harness/hub/hub.yaml
listen: http://127.0.0.1:8787
agent secret: hub.yaml agentSecret (HPC: DSH_HUB_AGENT_SECRET or --agent-secret-file)
```

放行反代的 443。浏览器打开 `https://<Hub域名>`，应看到登录页。

非回环地址上的明文 HTTP 默认拒绝。实验室短时试用才设置 `allowPlainHttp: true` 并 `host: 0.0.0.0`。

`hub.yaml` 只给 Hub 用。HPC 上的 `connect` 不读它。默认路径是 `$PWD/hub.yaml`；`serve` 每次都会打印 `config:` 绝对路径。指定文件：

```sh
dsh-hub serve --config /etc/dsh-hub/hub.yaml
dsh-hub serve --port 8788
```

```yaml
host: 127.0.0.1
port: 8787
agentSecret: "至少16个字符的随机串"
users:
  alice: "password"
  bob: "password"
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `port` | `8787` | 监听端口 |
| `host` | `127.0.0.1` | 监听地址；公网用反代，不要把 Hub 直接绑到 `0.0.0.0` |
| `agentSecret` | 必填 | `/agent` 升级所需的部署密钥，至少 16 个字符；HPC 的 `connect` 必须带同一值 |
| `allowPlainHttp` | `false` | 为 `true` 时才允许非回环明文 HTTP |
| `trustedProxies` | `[]` | 允许提供 `X-Forwarded-For` / `X-Forwarded-Proto` 的反代 IP；空列表表示忽略这些头 |
| `users` | 必填 | 登录用户名和密码 |

改完配置后重新执行 `serve`。文件里是明文口令和 `agentSecret`。首次 `serve` 会生成 `agentSecret`。

## 3. 从 HPC 连接

在跑 dsh 的那台机器、同一个 uid 下：

```sh
dsh-hub connect https://hub.example.com --user alice
```

密码和 Agent 密钥都在提示符输入（密钥来自 Hub 主机 `hub.yaml` 的 `agentSecret`）。进程保持运行。终端出现 `connecting` 后，回到浏览器用同一账号登录，应进入工作站。

断线后自动重连。

非交互（文件权限必须是 `0600`）：

```sh
printf '%s' '你的密码' > ~/.dsh-hub-password
printf '%s' 'hub.yaml里的agentSecret' > ~/.dsh-hub-agent-secret
chmod 600 ~/.dsh-hub-password ~/.dsh-hub-agent-secret
dsh-hub connect https://hub.example.com --user alice --password-file ~/.dsh-hub-password --agent-secret-file ~/.dsh-hub-agent-secret
```

或：

```sh
export DSH_HUB_PASSWORD
export DSH_HUB_AGENT_SECRET
dsh-hub connect https://hub.example.com --user alice
```

命令行不接受 `--password` 或 `--agent-secret`。

HPC 需要走 HTTP 代理才能访问 Hub 时：

```sh
export HTTPS_PROXY=http://proxy:port
export HTTP_PROXY=http://proxy:port
dsh-hub connect https://hub.example.com --user alice
```

`connect` 会启动 dsh。其余参数原样转发：

```sh
dsh-hub connect https://hub.example.com --user alice --patch extra.yml
dsh-hub connect https://hub.example.com --user alice --profile myweb
dsh-hub connect https://hub.example.com --user alice -- --trusted-host lab.example.com
dsh-hub connect https://hub.example.com --user alice --dump-config
```

`--` 之后的参数全部交给 dsh。

## 4. 浏览器里怎么用

1. 打开 `https://<Hub域名>`
2. 用 Hub 用户登录
3. 按 DSH Web 使用

选择工作区在页面里完成。侧栏底部退出登录。点产物可预览代码、图片和 PDF；SVG 按纯文本下发（`Content-Disposition: attachment`），不会作为 Hub 源上的活动文档打开。表格和大型数据文件（csv、h5ad、rds 等）不会打开。

没有在线 Agent 时显示离线页。

## HTTPS

公网或非回环部署必须在 Hub 前面终止 TLS。Hub 进程只提供 HTTP，默认绑 `127.0.0.1`。

`hub.yaml`：

```yaml
host: 127.0.0.1
port: 8787
agentSecret: "与HPC上connect使用的相同"
trustedProxies:
  - 127.0.0.1
users:
  alice: "password"
```

`trustedProxies` 列出反代的 TCP 地址之后，Hub 才读取 `X-Forwarded-For`（取最右侧一跳）和 `X-Forwarded-Proto`（用于 `Secure` cookie）。未列出时忽略这些头，避免客户端伪造以绕过登录/`/agent` 限速。

Caddyfile：

```caddy
hub.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

```sh
dsh-hub serve --config /path/to/hub.yaml
dsh-hub connect https://hub.example.com --user alice
```

实验室在可信网络上短时用明文时，YAML 设 `host: 0.0.0.0` 与 `allowPlainHttp: true`，或 `serve --allow-plain-http`；`connect` 对非回环 `http://` 要加 `--allow-plain-http`。

## 开机自启（Hub）

`/etc/systemd/system/dsh-hub.service`：

```ini
[Unit]
Description=DSH Hub
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/deepseek-harness/hub
ExecStart=/usr/bin/dsh-hub serve --config /etc/dsh-hub/hub.yaml
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now dsh-hub
```

HPC 上的 `connect` 同样需要长期运行（计算节点上的 job、tmux 或 systemd user 服务）。`connect` 与 dsh 必须在同一节点、同一 uid。

## 命令

| 主机 | 命令 |
|---|---|
| Hub | `dsh-hub serve` |
| HPC | `dsh-hub connect <url>` |

```sh
dsh-hub --help
npm test
```

## 故障排查

| 现象 | 处理 |
|---|---|
| 不知道 `hub.yaml` 在哪 | 只在 Hub 主机。默认 `$PWD/hub.yaml`。看 `serve` 打印的 `config:` |
| 只有本机能打开登录页 | 公网应走 TLS 反代；不要把 `host` 写成 `0.0.0.0` 除非同时设了 `allowPlainHttp` |
| `找不到 dsh` | 把 `dsh` 加入 `PATH`，或在仓库根目录 `pnpm install && pnpm run build` |
| `Cannot find package '@dsh-hub/preview'`（或 logout / webserver-unix） | 全局 `dsh` 从自身安装目录解析裸包名，不会看 Hub 仓库。升级本仓库后再执行一次 `dsh-hub connect`；connect 会把这三个包链进 dsh 的 `node_modules`。若 dsh 装在只读目录，把该安装改为用户可写后再 connect |
| `工作站启动超时` | dsh 没起来，看同一终端的 stderr |
| 登录后一直离线 | `connect` 没在跑、用户名和 `hub.yaml` 不一致、HPC 访问不到 Hub，或 `agentSecret` 与 connect 侧不一致 |
| 密码文件报错 | 权限必须是 `0600`，不能被其他人读 |
| 点产物一直加载 | 强制刷新浏览器后再试 |
