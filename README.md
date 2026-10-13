# NOC Automation Tool

A self-contained Node.js web app to run automation jobs (e.g. Python scripts) on a
cron schedule or manually, with an **encrypted-at-rest secrets vault** whose secrets
are injected into jobs as environment variables at run time.

## Features

- **Admin authentication** — the whole UI is behind a single-user login (username +
  password in `.env`). Sessions use an HTTP-only signed cookie and are stored in
  SQLite, so they survive restarts. Failed logins are rate limited and every form is
  CSRF-protected.
- **Scripts** — write Python and Bash scripts in a browser code editor (syntax
  highlighting, Ctrl+S, syntax check on save), test them with arguments and vault
  secrets while watching live output, browse/diff/restore every saved version, and
  schedule them as jobs in one click. Files live in `scripts/` so they stay editable
  outside the tool too.
- **Python packages** — a managed virtualenv for scripts: edit `requirements.txt`,
  install/uninstall with live pip output.
- **Jobs** — run a library script (with arguments) or a shell command, with an optional schedule, a working directory,
  and a timeout. Trigger manually ("Run now") or let it run on its cron schedule.
  A job never runs twice at once, running jobs can be cancelled, and the jobs list
  shows each job's last result and next scheduled time.
- **Secrets Vault** — store secrets encrypted at rest with **AES-256-GCM** using a
  master key kept out of the database (in `.env`). Values are never displayed again
  and only decrypted in memory when a linked job runs. Secrets can be created, edited
  (value changed, name fixed), or deleted.
- **Run history** — every execution records status, timing, exit code, and captured
  output. Output streams in while a job runs; filter history by job or status, and
  optionally prune old runs automatically.
- **Zero native dependencies** — SQLite via Node's built-in `node:sqlite` module
  (Node >= 22.5), so `npm install` needs no C++ toolchain.

## Requirements

- Node.js **>= 22.5** (uses the built-in `node:sqlite` module)
- Python (or any interpreter) for your scripts, if you run Python jobs

## Setup

```bash
npm install

# Create your .env with a strong random master key:
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# paste the output as MASTER_KEY in .env

# Also set your admin login:
#   ADMIN_USERNAME=admin
#   ADMIN_PASSWORD=<a strong password you choose>

npm start
# -> http://localhost:3000  (you'll be asked to sign in)
```

The `MASTER_KEY` is the only thing that can decrypt the vault. Losing it makes stored
secrets unrecoverable. Keep a secure backup. The `ADMIN_PASSWORD` is compared with a
constant-time check; set a strong value and restrict file permissions on `.env`
(`chmod 600 .env`).

## Configuration

All settings live in `.env` (see `.env.example`):

| Variable | Default | Purpose |
|---|---|---|
| `MASTER_KEY` | — (required) | 64-hex-char key that encrypts the vault |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | `admin` / — (required) | Login credentials |
| `SESSION_SECRET` | `MASTER_KEY` | Signs session cookies |
| `APP_PORT` / `APP_HOST` | `3000` / all interfaces | Where the server listens (`APP_HOST=127.0.0.1` for local only) |
| `DB_PATH` | `./data/automation.db` | SQLite database file |
| `APP_TZ` | `Asia/Kolkata` (IST) | Time zone for cron schedules, every time shown in the UI, and the `TZ` given to jobs |
| `SCRIPTS_DIR` | `./scripts` | Folder holding the script library (relative to the project) |
| `VENV_DIR` | `./data/venv` | Managed Python virtualenv used by scripts once created |
| `PYTHON_BIN` | `python3` | Python used before a virtualenv exists, and to create it |
| `RUN_RETENTION_DAYS` | `0` (keep forever) | Delete run history older than this many days |
| `COOKIE_SECURE` | `false` | Set `true` when serving over HTTPS |
| `TRUST_PROXY` | unset | Express `trust proxy` setting when behind a reverse proxy (e.g. `1`), so login rate limiting sees real client IPs |

## Usage

1. **Sign in** with the admin credentials from `.env`. Without an authenticated
   session every page redirects to `/login`.
2. **Add a secret** (`/secrets/new`) — give it a name (this becomes the env var name)
   and a value. It is encrypted before hitting disk. Use **Edit** on a secret to
   change its value later.
3. **Create a job** (`/jobs/new`) — set the command (e.g. `python3 report.py`),
   pick a schedule, and tick the secrets that job may read. The schedule builder
   offers manual, every N minutes, hourly, daily, weekly (pick days), monthly, or an
   advanced raw cron expression, and previews the next run times in IST.
4. **Run it** — press **Run now** for an immediate run, or enable scheduling and set
   a cron expression for automatic runs. If the job is already running, the new run
   is skipped rather than overlapping.
5. **Watch output** (`/runs`) — the run page refreshes while the job runs and shows
   output as it arrives. Use **Cancel run** to stop it.

Run statuses: `success`, `failed` (non-zero exit), `timed_out`, `cancelled`, and
`interrupted` (the server stopped mid-run; such runs are closed out at startup).

Linked secrets are decrypted in memory and exported as environment variables to the
child process, so your script reads them via `process.env` / `os.environ`, e.g.:

```python
import os
api_key = os.environ["API_KEY"]
```

## Scripts and packages

- **Scripts** (`/scripts`): create a script from a Python or Bash template, edit it in
  the browser, and press **Run test** to run the editor's current contents (saved or
  not) with optional arguments and vault secrets; output streams live. Saving runs a
  syntax check (`python compile` / `bash -n`) and refuses broken code, marking the
  line. Every save is a version you can diff against the previous one or restore.
  Files already in `scripts/` are imported at startup, and edits made to the files
  outside the tool are picked up as new versions.
- **Schedule this script** opens the job form prefilled with the script, arguments and
  secrets. Script jobs always run the current saved file.
- **Python packages** (`/packages`): create the virtualenv, then edit
  `scripts/requirements.txt` and **Save & install**. Once the virtualenv exists, all
  Python scripts and jobs run with it, so install your scripts' dependencies there
  (the repo's `requirements.txt` lists what `jsm_daily.py` needs).
- The editor bundle is built from `editor/index.js` into `public/vendor/editor.js`
  (committed, so no build step is needed to run the app). Rebuild with
  `npm run build:editor` after changing it.

## Security notes

- Secrets encrypted with AES-256-GCM; a fresh random IV is used per encryption and
  the ciphertext is authenticated (tampering is detected).
- The master key lives only in `.env`, never in the database.
- Secret values are never returned by the API or shown in the UI.
- The admin password is verified with a `crypto.timingSafeEqual` constant-time
  comparison and never logged. After 5 failed logins from one IP, login is locked
  for 15 minutes. The session ID is regenerated on login.
- Sessions use an HTTP-only, SameSite cookie; set `COOKIE_SECURE=true` if you serve
  over HTTPS. All state-changing forms carry a per-session CSRF token.
- Jobs run in their own process group; timeouts, cancellations and server shutdown
  kill the whole group, so child processes don't linger.
- **Anyone who can sign in can write and run arbitrary code on this server** through
  the script editor and job commands. Keep the tool on localhost, a VPN or an internal
  network, and use a strong admin password. Script saves, deletes and package changes
  are recorded in an audit log shown on the Scripts and Packages pages.
- **This is still a local single-user tool.** Auth gates the UI, but it isn't a full
  multi-user identity system. Prefer keeping it on localhost or behind a VPN/reverse
  proxy rather than exposing it directly to the internet.

## Testing

```bash
npm test
```

`test/automation.test.js` covers the vault (round-trip, tamper detection), the runner
(success/failure/timeout, process-group kill, cancellation, output cap, live output),
the scheduler (secret injection, no overlapping runs, cancel, next-run time, invalid
cron), run cleanup and retention, input validation, credentials, login rate limiting
and the SQLite session store. `test/http.test.js` boots the real app and checks login,
CSRF rejection, form validation, a full create-secret → create-job → run flow,
logout, and login lockout.

## Project structure

```
├── server.js              # entry: env, DB, scheduler boot, listen, graceful shutdown
├── src/
│   ├── app.js             # express app factory (routes, auth, CSRF, error handling)
│   ├── auth.js            # SQLite session store, login verify, CSRF, rate limiting
│   ├── validate.js        # job/secret form validation
│   ├── scripts.js         # script library: files, versions, syntax check, import
│   ├── tasks.js           # live-streamed processes (script tests, pip) over SSE
│   ├── diff.js            # line diff for version history
│   ├── schedule.js        # friendly schedule builder <-> cron, descriptions, next runs
│   ├── time.js            # IST (APP_TZ) formatting helpers
│   ├── ui.js              # icon + status badge helpers for views
│   ├── db.js              # node:sqlite setup + schema, run cleanup/retention
│   ├── vault.js           # AES-256-GCM encrypt/decrypt
│   ├── scheduler.js       # node-cron registration, manual triggers, overlap guard, cancel
│   ├── runner.js          # spawn scripts in a process group, capture output, timeout/cancel
│   └── routes/            # auth, jobs, secrets, runs, scripts, packages, tasks
├── editor/                # CodeMirror source → public/vendor/editor.js (npm run build:editor)
├── views/                 # server-rendered EJS pages (+ auth/login)
├── scripts/               # sample scripts to automate
└── test/                  # node:test suite
```

## Good to know
- Run output is capped at ~1 MB per run to keep the log table bounded.
- Python jobs run with `PYTHONUNBUFFERED=1` so their output appears live.
- Everything runs in IST by default: cron schedules, all times shown in the UI, server
  logs, and jobs (which get `TZ=Asia/Kolkata`). Timestamps are stored in UTC in the
  database and converted for display; set `APP_TZ` to use a different zone.
- `scripts/jsm_daily.py` reads its paths from `JSM_SCRIPTS_HOME` (default
  `/var/scripts`), or `JSM_LOG_DIR`, `JSM_OUTPUT_DIR` and `JSM_ENV_FILE` individually.
  It exits non-zero if the report email fails, so the run shows as `failed`.
- Deleting a secret only breaks jobs that reference it; existing runs are untouched.
