# Running NOC Automation as a systemd service

Running the app as a systemd service means it:

- starts automatically when the server boots,
- restarts by itself if it crashes,
- keeps running after you log out, and
- writes its output to the system journal.

Scheduled jobs only run while the app is running, so this is the recommended setup for a server.

The service runs as your normal user (never root). It reads `.env` from the project folder just as `npm start` does.

## Requirements

- Linux with systemd (`systemctl --version`)
- Node.js installed (`node --version`; 22.5 or newer)
- `sudo` rights, needed only to install or remove the service
- A filled-in `.env` in the project folder (copy `.env.example`)
- For the Docker pages: your user in the `docker` group (`id` lists the groups)

## Quick install (recommended)

From the project folder, as your normal user (not root):

```bash
./deploy/install-service.sh install
```

The script:

1. Fills in your user, group, home folder, the project path and the path to `node` in `deploy/noc-automation.service`.
2. Writes the result to `/etc/systemd/system/noc-automation.service`.
3. Stops a copy started with `./app.sh`, if one is running, so the port is free.
4. Runs `systemctl daemon-reload` and `systemctl enable --now noc-automation`.
5. Waits until the app answers and prints its URL.

To run it as a different user: `SERVICE_USER=otheruser ./deploy/install-service.sh install`.

## Manual install

1. Copy the template and fill in the placeholders:

   ```bash
   sudo cp deploy/noc-automation.service /etc/systemd/system/noc-automation.service
   sudo nano /etc/systemd/system/noc-automation.service
   ```

   | Placeholder | Replace with | Example |
   |---|---|---|
   | `@USER@` | the user the app runs as | `vijay` |
   | `@GROUP@` | that user's main group (`id -gn`) | `vijay` |
   | `@APP_DIR@` | full path of the project folder | `/home/vijay/noc-automation` |
   | `@NODE@` | full path of node (`command -v node`) | `/usr/bin/node` |
   | `@HOME@` | that user's home folder | `/home/vijay` |

2. Stop any copy started with `./app.sh` (`./app.sh stop`). Do this before installing the unit: once it's installed, `app.sh` manages the service instead.
3. Load, enable at boot and start it:

   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now noc-automation
   ```

4. Check it:

   ```bash
   systemctl status noc-automation
   curl -I http://localhost:3000/login
   ```

## Day-to-day commands

| Task | Command |
|---|---|
| Status | `systemctl status noc-automation` |
| Restart (e.g. after editing `.env` or `git pull`) | `sudo systemctl restart noc-automation` |
| Stop / start | `sudo systemctl stop noc-automation` / `sudo systemctl start noc-automation` |
| Follow the logs | `journalctl -u noc-automation -f` |
| Last 100 log lines | `journalctl -u noc-automation -n 100` |
| Logs since a time | `journalctl -u noc-automation --since "2026-10-29 09:00"` |
| Don't start at boot | `sudo systemctl disable noc-automation` |

`./app.sh` keeps working. Once the service is installed it becomes a shortcut to these commands:

- `./app.sh start`, `./app.sh stop` and `./app.sh restart` call `sudo systemctl …`.
- `./app.sh status` shows the service status.
- `./app.sh logs` follows the journal.

This way you can't accidentally start a second copy.

## How it behaves

- **Stopping:** systemd sends SIGTERM to the app only (`KillMode=mixed`). The app cancels running jobs itself and records them as cancelled. Anything still alive after 20 seconds (`TimeoutStopSec`) is force-killed.
- **Crashes:** the app is restarted after 5 seconds (`Restart=on-failure`). A normal `systemctl stop` doesn't trigger a restart.
- **Boot order:** the app starts after networking and Docker are up.
- **PATH for jobs:** `~/.local/bin:/usr/local/bin:/usr/bin:/usr/local/sbin:/usr/sbin`. The service doesn't load your shell profile, so a job that relies on something added to `PATH` in `.bashrc` should use full paths, or you can add the folder to the `Environment=PATH=` line in the unit.
- **Groups:** the service gets the user's supplementary groups, including `docker`. If you add the user to a group later, run `sudo systemctl restart noc-automation`.

## Updating the app

```bash
cd /home/vijay/noc-automation
git pull
npm install --omit=dev        # only if package.json changed
sudo systemctl restart noc-automation
```

If you change the unit file in `/etc/systemd/system/`, run `sudo systemctl daemon-reload` before restarting. To regenerate it from the template, run `./deploy/install-service.sh install` again.

## Uninstall

```bash
./deploy/install-service.sh uninstall
```

or by hand:

```bash
sudo systemctl disable --now noc-automation
sudo rm /etc/systemd/system/noc-automation.service
sudo systemctl daemon-reload
```

Your data (`data/`, `.env`, scripts) is not touched. Start the app with `./app.sh start` again if you still need it.

## Troubleshooting

Start with the last log lines: `journalctl -u noc-automation -n 50 --no-pager`.

| Symptom | Likely cause and fix |
|---|---|
| `EADDRINUSE` in the log | Something else uses the port, often a copy started with `npm start` or `app.sh` before the service was installed. Stop it, or change `APP_PORT` in `.env`, then restart the service. |
| `MASTER_KEY must be a 32-byte…` | `.env` is missing or incomplete in the project folder. |
| Docker page says permission denied | The user isn't in the `docker` group: `sudo usermod -aG docker <user>`, then restart the service. |
| A job works in a terminal but fails under the service | Usually `PATH` or environment. Use full paths in the command, or add the folder to `Environment=PATH=` in the unit. |
| `journalctl` shows nothing for your user | Reading system logs needs the `wheel`, `adm` or `systemd-journal` group. Use `sudo journalctl -u noc-automation`. |
| Service keeps restarting | `systemctl status noc-automation` shows the exit code, and the journal shows why. |
