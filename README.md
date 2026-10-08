# NOC Automation Tool

A self-contained Node.js web app to run automation jobs (e.g. Python scripts) on a
cron schedule or manually, with an **encrypted-at-rest secrets vault** whose secrets
are injected into jobs as environment variables at run time.

## Features

- **Admin authentication** — the whole UI is behind a single-user login (username +
  password in `.env`). Sessions use an HTTP-only signed cookie.
- **Jobs** — define a shell command, an optional cron schedule, a working directory,
  and a timeout. Trigger manually ("Run now") or let it run on its cron schedule.
- **Secrets Vault** — store secrets encrypted at rest with **AES-256-GCM** using a
  master key kept out of the database (in `.env`). Values are never displayed again
  and only decrypted in memory when a linked job runs. Secrets can be created, edited
  (value changed, name fixed), or deleted.
- **Run history** — every execution records status, timing, exit code, and captured
  output; view full logs per run.
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

## Usage

1. **Sign in** with the admin credentials from `.env`. Without an authenticated
   session every page redirects to `/login`.
2. **Add a secret** (`/secrets/new`) — give it a name (this becomes the env var name)
   and a value. It is encrypted before hitting disk. Use **Edit** on a secret to
   change its value later.
3. **Create a job** (`/jobs/new`) — set the command (e.g. `python3 report.py`),
   optionally a cron schedule, and tick the secrets that job may read.
4. **Run it** — press **Run now** for an immediate run, or enable scheduling and set
   a cron expression for automatic runs.
5. **Watch output** (`/runs`) — see status and full logs.

Linked secrets are decrypted in memory and exported as environment variables to the
child process, so your script reads them via `process.env` / `os.environ`, e.g.:

```python
import os
api_key = os.environ["API_KEY"]
```

## Security notes

- Secrets encrypted with AES-256-GCM; a fresh random IV is used per encryption and
  the ciphertext is authenticated (tampering is detected).
- The master key lives only in `.env`, never in the database.
- Secret values are never returned by the API or shown in the UI.
- The admin password is verified with a `crypto.timingSafeEqual` constant-time
  comparison and never logged. Sessions use an HTTP-only, SameSite cookie; set
  `cookie.secure = true` in `src/auth.js` if you ever serve over HTTPS.
- **This is still a local single-user tool.** Auth gates the UI, but it isn't a full
  multi-user identity system. Prefer keeping it on localhost or behind a VPN/reverse
  proxy rather than exposing it directly to the internet.

## Testing

```bash
npm test
```

Covers vault encrypt/decrypt round-trip and tamper detection, job runner
success/failure/timeout paths, env-var injection, an end-to-end job run that links a
secret, safe handling of invalid cron schedules, admin credential verification
(including the no-password-configured case), and a secret-value edit round-trip.

## Project structure

```
├── server.js              # entry: express app + session/auth + scheduler boot
├── src/
│   ├── auth.js            # session setup + admin login/verify (constant-time)
│   ├── db.js              # node:sqlite setup + schema
│   ├── vault.js           # AES-256-GCM encrypt/decrypt
│   ├── scheduler.js       # node-cron registration + manual triggers
│   ├── runner.js          # spawn scripts, capture output, timeout
│   └── routes/            # auth (login/logout), jobs, secrets, runs
├── views/                 # server-rendered EJS pages (+ auth/login)
├── scripts/               # sample scripts to automate
└── test/                  # node:test suite
```

## Good to know
- Run output is capped at ~1 MB per run to keep the log table bounded.
- Deleting a secret only breaks jobs that reference it; existing runs are untouched.
