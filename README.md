# The Ancient One's Trials — Interview Scheduling System

SheCodes · Webster 2026. Three independent parts that meet only at the contracts in `contracts/`:

| Part | Folder | Owner | Talks to others through |
|---|---|---|---|
| A — Frontend (React + Vite) | `frontend/` | Vaishnavi | REST + SSE contract (section 4.3 / 4.5) |
| B — Scheduler (pure Python, OR-Tools) | `scheduler/` | Varnika | `solve_batch` / `reschedule` dict contract (4.4) |
| C — Backend & database | `backend/` | Ishika | exposes 4.3, calls 4.4 |

```
 browser ──HTTPS──▶ nginx ──/api──▶ FastAPI (uvicorn) ──SQL──▶ PostgreSQL
    ▲                  │                 │  ▲                     ▲
    │ SSE (/api/events)│ static dist     │  └── Redis ◀──pub/sub──┤
    └──────────────────┘                 └─enqueue─▶ Celery worker + beat ──▶ scheduler.solve_batch / reschedule
                                                        (solver, outbox → e-mail / in-app, reminders, results)
```

## 1. Prerequisites
Python 3.11+, PostgreSQL 14+ (needs the `btree_gist` extension, shipped with the standard contrib package), Redis 6+, Node 18+ (frontend).

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp infra/.env.example .env && set -a && source .env && set +a      # edit JWT_SECRET etc.
```

## 2. Setup order
```bash
# 1) PostgreSQL: create the DB, migrate + seed
createdb trials
python db/migrate.py --seed            # add --reset to wipe first (dev only)

# 2) Redis
redis-server &

# 3) API
uvicorn app.main:app --port 8000

# 4) Worker + beat (solver, outbox, reminders, results, deadline auto-match)
celery -A workers.celery_app worker -B --loglevel=info

# 5) Frontend (Vaishnavi's part)
cd ../frontend && npm install && VITE_USE_MOCK=false npm run dev
```
No worker handy? `CELERY_EAGER=true` runs every task inline inside the API (demo only).

### Seed accounts (password for all: `Passw0rd!`)
| Role | Email | Notes |
|---|---|---|
| COORDINATOR | `coordinator@trials.edu` | |
| INTERVIEWER | `arjun@kamartaj.com` | Kamar-Taj Labs · Coding, Tech |
| INTERVIEWER | `meera@kamartaj.com` | Kamar-Taj Labs · Coding, HR |
| INTERVIEWER | `kabir@sanctum.io` | Sanctum Systems · Coding, Tech, HR |

Also seeded: 2 companies, 3 rooms, 12 sample slots on 2026-11-03 (they only matter while that date is in the future — interviewers can always declare fresh availability). Students register themselves. Regenerate hashes with `python db/make_seed_hashes.py [password]`.

## 3. Environment variables (`backend/infra/.env.example`)
`DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `JWT_EXPIRY_MINUTES`, `SLOT_MINUTES` (30), `CACHE_TTL_SECONDS`, `CORS_ORIGINS`, **`USE_STUB_SOLVER`** (true = greedy stub, false = `scheduler` package), `SOLVER_TIME_LIMIT`, `RESCHEDULE_TIME_LIMIT`, `RESEND_API_KEY` / `SENDGRID_API_KEY` / `EMAIL_FROM` / `EMAIL_DRY_RUN`, `OUTBOX_MAX_ATTEMPTS`, `CELERY_EAGER`. Runtime settings live in the `config` table: `result_delay_minutes` (default 30) and `matching_deadline` (ISO-8601 UTC; when passed, the beat task runs matching once for every round that has pending preferences).

## 4. Integration order (after all three parts exist)
1. Run migrations + seed (above).
2. Drop `scheduler/` in next to `backend/` and set `USE_STUB_SOLVER=false` (the single switch is `matching_service.get_solver()`; the backend does `from scheduler import solve_batch, reschedule`).
3. Set `VITE_USE_MOCK=false` in the frontend.
4. Run the demo script below.

## 5. Demo script
1. **Register students** in the UI (or `POST /api/auth/register`).
2. **Interviewer availability** — log in as `arjun@kamartaj.com`, choose the Kamar-Taj profile/skills if prompted, and declare a time range (`PUT /api/interviewer/availability`). 30-minute slots are created, each with a free room; no free room → no slot.
3. **Students rank slots** — `GET /api/companies/1/slots?roundNo=1`, then rank up to 3 (`POST /api/student/preferences` → `{"status":"PENDING"}` immediately; nothing is solved yet).
4. **Coordinator runs matching** — `POST /api/coordinator/matching/run {roundNo:1}` → `{jobId}`; the Celery worker solves and stores a new `DRAFT` version. Students nobody could seat get a `MATCH_FAILED` notification.
5. **Interviewer confirms** the proposal (`/api/interviewer/proposals`, `…/confirm`) → `INTERVIEWER_CONFIRMED`.
6. **Coordinator approves** the draft version (`POST /api/coordinator/drafts/{id}/approve {version}`); a stale version gets `STALE_DRAFT`. One transaction books slots, confirms interviews and writes the outbox rows.
7. **E-mails / ICS / notifications** — the beat task (every 10 s, or kicked immediately) delivers the in-app + e-mail rows; the `.ics` is at `GET /api/student/interviews/{id}/ics`. Live events arrive on `GET /api/events` (SSE).
8. **Interviewer cancels** (`…/cancel`) → interview `FLAGGED` → `repair_task` → `scheduler.reschedule` → moved interviews get a new `version` and `INTERVIEW_CHANGED`; unresolved ones are cancelled and the student is told to re-pick.
9. **Results** — interviewer declares PASS/FAIL (`…/result`); it is hidden until `release_at` (`result_delay_minutes`), then `RESULT_RELEASED` fires and a PASS unlocks the next round (Coding → Tech → HR).

## 6. Design decisions worth knowing
* **Invariant 1 (no double booking)** is enforced by the database even if the app is bypassed: `UNIQUE(slot_id)` on `interview_panel`, plus `EXCLUDE USING gist` on interviewer (booked panel rows), room and student (committed interviews). Violations surface as `SLOT_TAKEN`. Proven by `tests/test_api.py::DatabaseIsTheFinalGuard`.
* **Invariant 2** — submitting preferences never touches the solver; `solve_round_task` is the only caller of `solve_batch`.
* **Invariant 3** — approval locks the draft row, checks `version == latest` and `status == DRAFT`, else `STALE_DRAFT`. A new matching run supersedes earlier unapproved drafts and releases their held slots.
* **Invariants 4/5** — the commit and its outbox rows are one transaction; delivery is async with retries (`FOR UPDATE SKIP LOCKED`, up to `OUTBOX_MAX_ATTEMPTS`, then `FAILED`). A mail outage never fails a confirmation. Write endpoints claim their `Idempotency-Key` first, so concurrent retries run the work once and replay the stored response; a failed request releases the key.
* **Invariant 6** — a one-on-one is a panel of one; `interview_panel` is always used.
* **Passwords** use argon2id at the OWASP minimum (19 MiB, t=2, p=1): the library default was ~8× slower and made a 300-student registration rush CPU-bound on a 2-core box.
* **SSE & ICS tokens** — browsers cannot set headers on `EventSource` or a plain download link, so `/api/events` and the `.ics` route also accept `?token=<JWT>`. (Contract change requests: none — the contract paths and shapes are unchanged.)
* **Extra columns** beyond 4.2 (additive only): `schedule_drafts.matched/unmatched`, `interview_panel.start_ts/end_ts/booked/confirmed` (needed for the exclusion constraint and per-panelist confirmation), `results.released`, `notifications.created_at`, `outbox.last_error`.
* **Redis** is a cache and a live-event bus only; if it is down the API still works from the DB (live events are simply not pushed).

## 7. Tests & load test
```bash
cd backend
# DESTROYS and recreates the target DB — its name must end in _test
createdb trials_test
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/trials_test REDIS_URL=redis://localhost:6379/1 \
  python -m unittest discover -s tests -t . -v
```
37 `unittest` tests: auth/role guards, idempotent replay (incl. concurrent retries), ≤3 preference validation, stale-draft rejection, concurrent commit race (exactly one wins, the other gets `SLOT_TAKEN`), outbox retry/failure, mail outage during approval, ICS content, DB-level double-booking rejection, and the whole demo script end to end (matching → confirm → approve → cancel/repair → results → next round, plus blinded evaluations/ranking).

```bash
export DATABASE_URL=...   # enables the post-run double-booking audit
locust -f loadtest/locustfile.py --host http://localhost:8000 --users 301 --spawn-rate 60 --headless -t 60s
```
300 students register → login → submit preferences (each with a deliberate same-key retry) while one coordinator runs matching and approves; the audit then asserts no interviewer, room or student is double-booked.

## 8. Nginx
`backend/infra/nginx.conf`: TLS placeholders (replace the `CHANGE-ME` lines), static `frontend/dist`, `/api` proxy with per-IP and per-token `limit_req`, and `proxy_buffering off` for `/api/events`.

## 9. Known limits
* The real `scheduler/` package was not available when this part was built, so it was developed against the greedy `solver_stub.py` (same 4.4 shapes, verified against `contracts/solver_io.json`). Re-run the integration test once `scheduler/tests/fixtures/sample_input.json` exists.
* Google Calendar sync (optional stretch) is skipped: the `.ics` download link is the supported path.
* Panel (multi-interviewer) assignments are stored and displayed correctly, but matching builds panels only if the solver returns several `interviewerIds`.
* `nginx.conf` was not executed in the build environment (no nginx binary); check it with `nginx -t` after editing the placeholders.
