# Run Boof Runner on a server

This runbook takes a fresh Linux server (written for Ubuntu 24.04) to a Boof Runner that an AI harness can reach over HTTPS. Everything runs as your normal user; only the nginx and TLS steps need `sudo`.

What you need:

- Node.js 22.22 or newer (for example through nvm), git 2.43 or newer, and bun 1.3 (optional; npm works too).
- systemd 255 with user lingering on, so the service runs without a login session.
- The agent CLIs you want to use (`claude`, `codex`, `opencode`) installed for this user.
- A host name that points at the server, and nginx on the host (for TLS).

## 1. Install

On a machine without a display (no `DISPLAY` or `WAYLAND_DISPLAY`) the install script skips the desktop app: it does not download Electron (about 100 MB) and builds only the web UI and the CLI. Set `BOOF_RUNNER_SKIP_DESKTOP=0` to override.

```bash
git clone git@github.com:YaminT/boof.git ~/.local/share/boof-runner/source
bash ~/.local/share/boof-runner/source/scripts/install-or-update-boof-runner.sh
boof-runner --help | head -1
```

The script links `boof-runner` into your global npm prefix (with nvm that is under `~/.nvm`, no `sudo`). Other variables: `BOOF_RUNNER_DIR`, `BOOF_RUNNER_REPO`, `BOOF_RUNNER_BRANCH`, `BOOF_RUNNER_SKIP_UPDATE`, `BOOF_RUNNER_INSTALL_MODE`, `BOOF_RUNNER_FORCE_UPDATE` (see `--help`).

## 2. Choose the data root

The data root holds settings, API key hashes, tasks, plans and logs. Keep it outside the source checkout, on a disk you back up:

```bash
export BOOF_DATA="$HOME/.local/share/boof-runner/data"
mkdir -p "$BOOF_DATA" && chmod 700 "$BOOF_DATA"
```

Pass `-d "$BOOF_DATA"` to every command below (or `export BOOF_RUNNER_DATA_ROOT="$BOOF_DATA"`).

## 3. Register your repositories

```bash
boof-runner project add ~/codes/my-app --id my-app -d "$BOOF_DATA"
boof-runner project list -d "$BOOF_DATA"
```

Boof never merges or pushes. Each task gets its own worktree and a branch `boof-runner/<task-id>` inside the repository.

## 4. Prepare remote access

```bash
boof-runner remote setup --hostname boof.example.com --allowed-root ~/codes -d "$BOOF_DATA"
```

This turns authentication on, allows the host name, lets a harness register projects under `~/codes`, restricts the data root to your user and prints an API key once. Store the key now. Boof itself keeps listening on `127.0.0.1`; nginx is the public side.

## 5. Install the systemd service

```bash
boof-runner service install --data "$BOOF_DATA" --port 4319
boof-runner service status
sudo loginctl enable-linger "$USER"    # once, so it starts at boot and survives logout
```

`service install` writes `~/.config/systemd/user/boof-runner.service` with the absolute paths of node and the CLI and your current `PATH`, so the nvm node and the `claude`, `codex` and `opencode` CLIs are found. Run it from a shell where those commands work. Add environment with `--env KEY=VALUE` (repeatable), or load it from a private file with `--env-file <path>` (must be `chmod 600`; use this for secrets such as `ANTHROPIC_AUTH_TOKEN`, so they never appear in the unit file). Variables set only in your shell, for example fish universal variables or exports in `~/.bashrc`, are not seen by the service. It refuses a `--host` that boof itself would refuse; keep the default `127.0.0.1` behind nginx.

The runner is off until you switch it on: open the web UI (`ssh -L 4319:127.0.0.1:4319 server`, then `http://localhost:4319`) and turn on the runner in Settings, or set `"runner": { "enabled": true }` in `$BOOF_DATA/settings.json` and restart the service.

Useful commands:

```bash
boof-runner service status         # systemctl status and GET /healthz
boof-runner service logs -f        # journalctl --user -u boof-runner -f
systemctl --user restart boof-runner
boof-runner service uninstall      # removes the unit, keeps your data
```

`GET /healthz` is public and returns `{ ok, version, uptimeSeconds, runner: { enabled, running } }` with no project or task data; use it for uptime monitors. `runner.enabled` in the payload is cached for 5 seconds. On `systemctl stop` or a restart the runner asks the running task to stop (up to 30 s, `BOOF_RUNNER_SHUTDOWN_GRACE_MS`), kills the agent process, and leaves the task `failed` with its worktree kept. Retry it from the UI or API after the restart.

## 6. nginx

```bash
sudo cp ~/.local/share/boof-runner/source/deploy/nginx-boof.conf.example /etc/nginx/sites-available/boof
sudoedit /etc/nginx/sites-available/boof        # host name and certificate paths
sudo ln -s /etc/nginx/sites-available/boof /etc/nginx/sites-enabled/boof
sudo nginx -t && sudo systemctl reload nginx
```

Certificates: `sudo certbot --nginx -d boof.example.com` creates them and edits the server block; or run `sudo certbot certonly --webroot -w /var/www/html -d boof.example.com` first and keep the paths in the example. The `Host` header must reach boof unchanged (`proxy_set_header Host $host;`), and buffering must stay off for the live event stream.

**Path prefix.** To serve boof from a path of a site that already exists (for example `https://example.com/boof/`), include [deploy/nginx-boof-prefix.conf.example](nginx-boof-prefix.conf.example) inside that site's `server` block instead of adding a site of its own:

```bash
sudo cp ~/.local/share/boof-runner/source/deploy/nginx-boof-prefix.conf.example /etc/nginx/snippets/boof.conf
sudoedit /etc/nginx/sites-available/<site>      # add "include snippets/boof.conf;" inside the HTTPS server block
sudo nginx -t && sudo systemctl reload nginx
```

The trailing slash on `proxy_pass` strips `/boof`, so boof itself is unchanged; the web UI uses relative URLs and works under the prefix, and `X-Forwarded-Prefix` tells boof where it lives for the few URLs it emits itself (the OpenAPI `servers` entry, deprecation `Link` headers). boof trusts a loopback proxy by default (`"security": { "trustedProxies": ["loopback"] }` in `settings.json`), so it keys its unauthenticated rate limit on the client address nginx forwards (the last `X-Forwarded-For` entry) and the audit log's `forwardedFor` is trustworthy; if nginx runs on another host, list its address there instead. The snippet hides boof's `Strict-Transport-Security` header, which carries `includeSubDomains`; set HSTS in the site's server block if you want it. Run `remote setup --hostname example.com` with the site's host name, and send a harness `BOOF_URL=https://example.com/boof` (the API is then at `/boof/api/v1`, MCP at `/boof/mcp`).

Behind Cloudflare: use a proxied (orange cloud) DNS record, SSL mode Full (strict) with a valid certificate on the origin, and keep nginx's `proxy_buffering off;`. Cloudflare passes server-sent events as long as the origin does not buffer them, and drops idle connections after about 100 s, so clients reconnect with `Last-Event-ID` (boof replays missed events).

## 7. Give an AI harness access

Send the harness three things:

1. `BOOF_URL=https://boof.example.com`
2. the API key from step 4 (a secret; send it over a private channel)
3. the guide: `https://nodets.com/boof/harness.txt` (or `https://boof.example.com/harness.txt`, which needs no key)

Check it works: `curl https://boof.example.com/healthz`, then `curl -H "Authorization: Bearer $KEY" https://boof.example.com/api/v1/whoami`. Create more keys with `boof-runner auth add`.

## 8. Upgrade

```bash
bash ~/.local/share/boof-runner/source/scripts/install-or-update-boof-runner.sh
boof-runner service install --data "$BOOF_DATA"     # rewrites the unit and restarts a running service
# or only restart when nothing in the unit changed:
systemctl --user restart boof-runner
boof-runner service status
```

The script stops with a message if the checkout has uncommitted changes. Commit or stash them, or set `BOOF_RUNNER_FORCE_UPDATE=1` to save them to `~/.local/share/boof-runner/backups/<timestamp>.patch` (plus a tar of untracked files) and reset to the latest source. Restart (or run `service install` again) after changing the Node version so the unit records the new node path.

## 9. Back up

Back up the whole data root (settings, clients, tasks, plans, audit log): stop the service for a consistent copy or copy while idle.

```bash
systemctl --user stop boof-runner
tar -czf boof-data-$(date +%F).tar.gz -C "$(dirname "$BOOF_DATA")" "$(basename "$BOOF_DATA")"
systemctl --user start boof-runner
```

The task branches live in your repositories; back those up with your normal git remotes.

## Troubleshooting

| Symptom                                                         | Cause and fix                                                                                                                                                                                                                                       |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `421 Host not allowed`                                          | The `Host` header is not in `security.allowedHosts`. Run `boof-runner remote setup --no-key --hostname <name>` and make nginx send `proxy_set_header Host $host;`.                                                                                  |
| `401 Unauthorized`                                              | Missing, wrong, revoked or expired key. Send `Authorization: Bearer <key>`. Replace a lost key with `boof-runner auth rotate <id>`.                                                                                                                 |
| `service install` says it cannot reach the systemd user manager | Log in over ssh (not `su`), or `export XDG_RUNTIME_DIR=/run/user/$(id -u)`, and enable lingering: `sudo loginctl enable-linger $USER`.                                                                                                              |
| The service stops when you log out                              | Lingering is off: `sudo loginctl enable-linger $USER`.                                                                                                                                                                                              |
| Tasks fail with `claude`, `codex` or `opencode` not found       | The unit records the `PATH` of the shell that ran `service install`. Fix the `PATH`, run `service install` again, and check `GET /api/v1/health` or Settings for tool status.                                                                       |
| Agent says it is not logged in                                  | Log in once as the service user on the server: `claude` (then `/login`), `codex login`, `opencode auth login`. The credentials live in that user's home, which the unit sets as `HOME`.                                                             |
| An agent works in your shell but fails in the service           | Your shell sets variables the service does not see (for example `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` for a proxy, set as fish universal variables). Put them in a file, `chmod 600` it, and run `service install --env-file <file>` again. |
| Live log stalls or events arrive in bursts                      | A proxy is buffering. Keep `proxy_buffering off;` in nginx (and no response buffering in front of it).                                                                                                                                              |
| `413` on attachments                                            | Raise `client_max_body_size` in nginx (attachments are capped at 25 MB; 30m leaves room for the encoding).                                                                                                                                          |
| `service logs` shows nothing                                    | The user journal may not be persistent: `sudo mkdir -p /var/log/journal && sudo systemctl restart systemd-journald`.                                                                                                                                |
| `refusing to bind ...`                                          | A non-loopback `--host` needs `auth.mode = required` and one client. Keep `127.0.0.1` behind nginx, or run `remote setup` first.                                                                                                                    |
| Runner running but nothing starts                               | `runner.enabled` is false by default. Turn it on in Settings (or `settings.json`). `GET /healthz` shows `runner.enabled`.                                                                                                                           |
| A task stays `running` after a crash or reboot                  | The runner recovers it when it starts: the task becomes `failed` with an `### Interrupted` block and its worktree is kept. Restart the service (not with `--no-runner`), then retry the task.                                                       |
