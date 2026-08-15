# DSH Hub

English | [中文](README.zh.md)

Use DeepSeek Harness in a browser from a Unix-like machine (Linux or macOS). Hub runs on a public machine; the Unix-like machine only makes outbound connections and does not open inbound ports.

```text
browser  ──HTTPS──▶  Hub (public, TLS reverse proxy)  ◀──WSS (outbound)──  Agent + dsh (Unix-like)
```

![Hub login page with Username, Password, and English | 中文](docs/dsh_hub_screenshot01.jpg)

![Web workstation after sign-in: workspaces, chat, and sign-out](docs/dsh_hub_screenshot02.jpg)

Both machines need Node.js >= 22.19 and this repository. The Unix-like machine must also be able to run `dsh`.

```sh
node -v
```

After install the command is `dsh-hub`; you do not need `npx`.

## 1. Install

Run this on both machines:

```sh
git clone git@github.com:ZhimingYe/dsh-hub.git
cd dsh-hub
npm install
npm install -g .
```

Confirm the command is on `PATH`:

```sh
dsh-hub --help
```

After later upgrades, run `npm install -g .` again.
Without a global install, use `npx dsh-hub` from the repository root.

On the Unix-like machine, confirm `dsh` works:

```sh
dsh --help
```

If there is no global `dsh`, install [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), run `pnpm install && pnpm run build` at its repository root, and put `dsh` on `PATH`.

## 2. Start Hub

On the public machine:

```sh
dsh-hub serve --user alice
```

Enter a password at the prompt (it is not echoed). The first run writes `hub.yaml` in the current directory (mode `0600`, bcrypt hashes, not plaintext) and prints once:

```text
wrote /home/you/dsh-hub/hub.yaml
DSH_HUB_AGENT_SECRET=<random>
config: /home/you/dsh-hub/hub.yaml
listen: http://127.0.0.1:8787
connect: dsh-hub connect http://<host>:8787 --user alice
```

Copy the `DSH_HUB_AGENT_SECRET=` line to the Unix-like machine immediately (environment variable, `--agent-secret-file`, or a later prompt). Later `serve` runs do not print the plaintext. The yaml cannot recover that value.

Allow 443 on the reverse proxy. Open `https://<hub-host>` in a browser; you should see the login page (English by default, with an English | 中文 switch).

Cleartext HTTP on a non-loopback address is refused by default. Set `allowPlainHttp: true` and `host: 0.0.0.0` only for a short lab trial.

`hub.yaml` is for Hub only. `connect` on the Unix-like machine does not read it. The default path is `$PWD/hub.yaml`; every `serve` prints the absolute `config:` path. To choose a file:

```sh
dsh-hub serve --config /etc/dsh-hub/hub.yaml
dsh-hub serve --port 8788
```

```yaml
host: 127.0.0.1
port: 8787
agentSecret: "$2a$12$...."
users:
  alice: "$2a$12$...."
  bob: "$2a$12$...."
```

| Field | Default | Meaning |
|---|---|---|
| `port` | `8787` | Listen port |
| `host` | `127.0.0.1` | Listen address; use a reverse proxy on the public side, do not bind Hub to `0.0.0.0` |
| `agentSecret` | required | bcrypt hash of the `/agent` Bearer secret; `connect` on the Unix-like machine presents the matching plaintext |
| `allowPlainHttp` | `false` | Non-loopback cleartext HTTP is allowed only when `true` |
| `trustedProxies` | `[]` | Reverse-proxy IPs allowed to supply `X-Forwarded-For` / `X-Forwarded-Proto`; an empty list ignores those headers |
| `users` | required | Login usernames to bcrypt hashes |

Restart `serve` after editing the config. Do not put plaintext passwords or secrets in the yaml; a value that is not a bcrypt hash fails at load. To add a user:

```sh
dsh-hub hash
dsh-hub hash --password-file ~/.dsh-hub-password
```

Paste the printed hash into `users:`. To rotate the agent secret, `hash` again, replace `agentSecret`, and update the plaintext on the Unix-like machine. `hash` reads plaintext only from a prompt or `--password-file`, not from `DSH_HUB_PASSWORD`.

## 3. Connect from a Unix-like machine

On the machine that runs dsh, as the same uid:

```sh
dsh-hub connect https://hub.example.com --user alice
```

Enter the password and agent secret at the prompts. The secret is the `DSH_HUB_AGENT_SECRET` printed on first `serve`, not the hash in `hub.yaml`. The process stays running. After the terminal shows `connecting`, sign in in the browser with the same account; you should reach the workstation.

dsh HTTP uses a Unix socket: `$XDG_RUNTIME_DIR/dsh-hub-<uid>/workstation.sock`; if `XDG_RUNTIME_DIR` is unset, `/tmp/dsh-hub-<uid>/workstation.sock`. That directory must be owned by this uid and mode `0700` (not a symlink, not owned by someone else), or `connect` refuses to start. Shared login nodes should set `XDG_RUNTIME_DIR`.

Reconnect is automatic after a drop.

Non-interactive (file mode must be `0600`):

```sh
printf '%s' 'your-password' > ~/.dsh-hub-password
printf '%s' 'DSH_HUB_AGENT_SECRET-from-first-serve' > ~/.dsh-hub-agent-secret
chmod 600 ~/.dsh-hub-password ~/.dsh-hub-agent-secret
dsh-hub connect https://hub.example.com --user alice --password-file ~/.dsh-hub-password --agent-secret-file ~/.dsh-hub-agent-secret
```

Or:

```sh
export DSH_HUB_PASSWORD
export DSH_HUB_AGENT_SECRET
dsh-hub connect https://hub.example.com --user alice
```

The command line does not accept `--password` or `--agent-secret`.

When the Unix-like machine needs an HTTP proxy to reach Hub:

```sh
export HTTPS_PROXY=http://proxy:port
export HTTP_PROXY=http://proxy:port
dsh-hub connect https://hub.example.com --user alice
```

`connect` starts dsh. The default is equivalent to:

```text
dsh --profile workstation --patch <dsh-hub-install>/workstation.cordis.yml
```

Remaining arguments are forwarded to dsh as-is:

```sh
dsh-hub connect https://hub.example.com --user alice --patch extra.yml
dsh-hub connect https://hub.example.com --user alice --profile myweb
dsh-hub connect https://hub.example.com --user alice -- --trusted-host lab.example.com
dsh-hub connect https://hub.example.com --user alice --dump-config
```

Arguments after `--` all go to dsh. Do not disable or replace `webserver-unix`, `hub-logout`, or `hub-preview` in the overlay, or the tunnel or preview will break. `--profile myweb` still applies the Hub overlay; if that profile is not a Web workstation, the browser stays offline.

### Where workstation lives

`workstation` is a dsh profile for **this machine and this user**. It is not in the dsh-hub repository. Directory:

```text
$DSH_HOME/profiles/workstation/
```

If `DSH_HOME` is unset, that is `~/.dsh/profiles/workstation/`. Each user on the machine has their own copy. The first `connect` creates:

```text
package.json            # dependencies, and dsh.profile.bundles (which bundles load at start)
cordis.patch.yml        # this profile's own patch (starts as [])
pnpm-workspace.yaml
node_modules/
```

Startup stacks from an empty config; a later layer can change an earlier one:

1. Bundles in `dsh.profile.bundles`, in list order. The default is `@deepseek-ai/dsh-base` and `@deepseek-ai/dsh-web-app`; bundles installed with `dsh plugin add` are here too.
2. This profile's `cordis.patch.yml`
3. `$DSH_HOME/cordis.patch.yml` (shared by every profile on this machine; optional)
4. Hub's `workstation.cordis.yml` (added on every `connect`: Unix socket, sign-out, artifact preview)
5. Extra `--patch` files on the command line, in the order written

Hub's `@dsh-hub/webserver-unix`, `@dsh-hub/logout`, and `@dsh-hub/preview` are layer 4. They are not written into `dsh.profile.bundles`. `connect` links them into a `node_modules` that dsh can resolve.

### What a later connect overwrites

It does not empty the profile, remove bundles already added with `plugin add`, or rewrite a `cordis.patch.yml` you edited.

| Path | Later `connect` |
|---|---|
| `cordis.patch.yml` | Written as `[]` only if the file is missing |
| `pnpm-workspace.yaml` | Written only if missing |
| `dsh.profile.bundles` | Written as `dsh-base` + `dsh-web-app` only if missing or an empty array |
| Other `dependencies` | Kept |
| `file:` paths for `@dsh-hub/webserver-unix`, `logout`, `preview` | Rewritten each time to this dsh-hub install |
| Links for those three packages in `node_modules` | Relinked each time |
| `npm install` in the profile directory | Failures print to stderr only; the profile is not rolled back |

`dsh plugin` uses pnpm in that directory; `connect` may also run `npm install`. Do not mix hand `npm add` and `dsh plugin` in the same profile.

### Add plugins

For lasting use: the package must declare `dsh.bundle`, and `pnpm` must be on PATH.

```sh
dsh plugin --profile workstation add @some-bundle
```

A package without `dsh.bundle` only enters `dependencies` and does not load at start. To change this workstation's config lines, edit `~/.dsh/profiles/workstation/cordis.patch.yml`.

For this session only:

```sh
dsh-hub connect https://hub.example.com --user alice --patch /absolute/path/extra.yml
```

Plugin `name` values in `extra.yml` must be absolute paths, not bare package names:

```yaml
- insert:
  - id: hello
    name: '/ifs1/User/you/scratch-plugin/src/my-plugin.ts'
```

Install packages with `dsh plugin` and open the tunnel with `dsh-hub connect`. Do not put both on one command line (`dsh-hub connect … plugin …` only runs `dsh plugin` and then exits, with no tunnel).

### Upgrade

| What to update | How |
|---|---|
| Hub (login, tunnel, preview, sign-out) | Update dsh-hub, `npm install -g .`, then `connect` |
| Models, tools, the Web workstation itself | Upgrade `dsh` on the Unix-like machine |
| Bundles already in workstation | `dsh plugin --profile workstation add <package>` or pnpm `update` |

## 4. Use in the browser

1. Open `https://<hub-host>`
2. Sign in with a Hub user
3. Use DSH Web as usual

Pick a workspace in the page. Sign out is at the bottom of the sidebar. Clicking an artifact previews code, images, and PDFs, and only files under the current working directory or a registered workspace (`403` after `realpath` if still outside those roots). SVG is served as plain text (`Content-Disposition: attachment`) and is not opened as an active document on the Hub origin. Spreadsheets and large data files (csv, h5ad, rds, and similar) do not open.

The offline page is shown when no agent is online.

## HTTPS

Public or non-loopback deployments must terminate TLS in front of Hub. The Hub process speaks HTTP only and binds `127.0.0.1` by default.

`hub.yaml`:

```yaml
host: 127.0.0.1
port: 8787
agentSecret: "$2a$12$...."
trustedProxies:
  - 127.0.0.1
users:
  alice: "$2a$12$...."
```

After `trustedProxies` lists the reverse proxy's TCP address, Hub reads `X-Forwarded-For` (rightmost hop) and `X-Forwarded-Proto` (for `Secure` cookies). Those headers are ignored when the list is empty, so a client cannot spoof them to bypass login / `/agent` rate limits.

Caddyfile:

```caddy
hub.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

```sh
dsh-hub serve --config /path/to/hub.yaml
dsh-hub connect https://hub.example.com --user alice
```

For a short cleartext trial on a trusted network, set YAML `host: 0.0.0.0` and `allowPlainHttp: true`, or `serve --allow-plain-http`; `connect` to a non-loopback `http://` needs `--allow-plain-http`.

## Start Hub on boot

`/etc/systemd/system/dsh-hub.service`:

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

`connect` on the Unix-like machine also needs to stay running (tmux, a systemd user service, or a cluster job). `connect` and dsh must be on the same machine and uid.

## Commands

| Host | Command |
|---|---|
| Hub | `dsh-hub serve` |
| Hub | `dsh-hub hash` (bcrypt hash for hub.yaml) |
| Unix-like machine | `dsh-hub connect <url>` |

```sh
dsh-hub --help
npm test
```

## Troubleshooting

| Symptom | What to do |
|---|---|
| Do not know where `hub.yaml` is | Hub host only. Default `$PWD/hub.yaml`. See the `config:` line `serve` prints |
| Only this machine can open the login page | Public access should go through a TLS reverse proxy; do not set `host` to `0.0.0.0` unless `allowPlainHttp` is also set |
| `dsh` not found | Put `dsh` on `PATH`, or `pnpm install && pnpm run build` at the harness repository root |
| `Cannot find package '@dsh-hub/preview'` (or logout / webserver-unix) | Global `dsh` resolves bare names from its own install, not the Hub repo. Upgrade this repo and run `dsh-hub connect` again; connect links the three packages into dsh `node_modules`. If dsh is in a read-only prefix, install it somewhere writable and connect again |
| `--patch` cannot find a package | Write the plugin `name` as an absolute path, not a bare package name |
| Plugins gone after another `connect` | `dsh.profile.bundles` and `cordis.patch.yml` are not emptied; if you mixed `npm` and `dsh plugin`, look at `node_modules` in the same directory. See section 3 |
| `dsh plugin` cannot find pnpm | Put `pnpm` on PATH, then install the bundle |
| Workstation start timed out | dsh did not come up; see stderr on the same terminal |
| Loading `hub.yaml` complains about bcrypt | The field must be a hash from `dsh-hub hash` or first `serve`, not plaintext |
| Signed in but always offline | `connect` is not running, the username does not match `hub.yaml`, the Unix-like machine cannot reach Hub, or the agent secret is not the `DSH_HUB_AGENT_SECRET` from first `serve` |
| Lost `DSH_HUB_AGENT_SECRET` | The yaml cannot recover the plaintext. `dsh-hub hash` a new `agentSecret` and update the Unix-like machine |
| Password file error | Mode must be `0600`; others must not be able to read it |
| Artifact preview keeps loading | Force-refresh the browser and try again |
| Preview 403 `path not allowed` | The file must be under the current working directory or a registered workspace; a symlink must not point outside those roots |
| Socket directory error (symlink / not this user / not 0700) | Remove the occupied `/tmp/dsh-hub-<uid>`, or set `XDG_RUNTIME_DIR` and `connect` again |
