# Staging deployment

Phase 6's Milestone 1 gate asks for a staging URL. Everything needed to produce
one is in the repository; the single step that cannot be automated is connecting
a hosting account, because that requires creating an account and holding its
credentials.

This document is the runbook for that step, and for the three things that will
otherwise break the first deploy.

---

## The platform: Railway

Chosen over the alternatives for four reasons, in order of weight:

1. **It runs long-lived processes.** Phase 7 requires the BullMQ worker to be a
   *separate container* from the web app, and Phase 12 needs Server-Sent Events
   fanned out from a long-running process. A serverless-first host cannot do
   either, so choosing one now would mean moving hosts at Phase 7.
2. **Managed Postgres and Redis in one project.** Redis is not optional — it is
   Phase 7's queue backend. A platform supplying only Postgres means a second
   vendor and a second bill before the next phase is finished.
3. **It deploys the Dockerfile as-is.** Nothing platform-specific is compiled
   into the artefact, so `railway.json` is the only file that would have to
   change to move to Render, Fly or a plain VPS.
4. **`plan.md` §14 already recommends it** for a solo builder, and argues
   specifically against Vercel: a long-running host is needed for the worker and
   SSE regardless, so hosting both on one platform is simpler than splitting.

**Render is an equally defensible substitute** and needs only `railway.json`
swapped for a `render.yaml`. Nothing else in the repository changes.

---

## What is ready

| Artefact | Status |
|---|---|
| `Dockerfile` | Three-stage, non-root, `HEALTHCHECK` on `/api/healthz` |
| `.dockerignore` | Excludes `.env` — see the warning below |
| `railway.json` | Dockerfile builder, health check, restart policy |
| `next.config.ts` | `output: 'standalone'` |

Verified locally without Docker: the standalone server boots, serves `public/`,
emits the production security headers including HSTS, logs structured JSON as
`env: production`, and returns **503 `degraded`** — not a 500, and not a
misleading 200 — when the database is unreachable. That last behaviour is what
the platform health check depends on.

> **Not yet verified:** the Docker image build itself. Docker Desktop stopped
> partway through this work and cannot be restarted without elevation. Run
> `docker build -t cms-app:staging .` once it is back; the standalone output it
> wraps is already proven.

---

## Three things that will break the first deploy

### 1. The staging hostname must be registered, or every page 404s

This is the one that will waste an afternoon.

The league is resolved from the request hostname. `resolveLeagueByHostname()` in
`src/server/tenancy/current-league.ts` falls back to `DEFAULT_ORG_SLUG` **only
for localhost and `*.localhost`**. A Railway domain is neither, so it takes the
`org_domains` lookup path — and if the hostname is not in that table the function
returns `null` and the entire site 404s.

Note that the code comment claims the fallback covers "preview deploys". It does
not. Trust the code.

So, immediately after the database exists:

```sql
INSERT INTO org_domains (org_id, hostname, is_primary)
SELECT id, 'your-app.up.railway.app', false FROM organizations WHERE slug = 'kelowna';
```

### 2. The application must NOT connect as the superuser

The entire security model rests on this. PostgreSQL **silently ignores RLS
policies for superusers**, so an app connected as one has no tenant isolation at
all — and nothing fails loudly to tell you.

A managed Postgres hands you exactly one superuser. Create the two real roles
before deploying, mirroring `db/init/01-roles-and-extensions.sql`:

```sql
CREATE ROLE migrator WITH LOGIN PASSWORD '<generate>' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE app_user WITH LOGIN PASSWORD '<generate>' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

GRANT CONNECT ON DATABASE railway TO migrator, app_user;
GRANT CREATE  ON DATABASE railway TO migrator;
GRANT USAGE, CREATE ON SCHEMA public TO migrator;
GRANT USAGE ON SCHEMA public TO app_user;

ALTER DEFAULT PRIVILEGES FOR ROLE migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES FOR ROLE migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_user;
```

`POSTGRES_URL` gets `app_user`. `MIGRATION_DATABASE_URL` gets `migrator`.
Neither gets the superuser.

`scripts/migrate.ts` re-interrogates `pg_catalog` on every run and **fails the
migration** if this drifts, so a mistake here is caught rather than silently
accepted.

### 3. The seed refuses to run in production, by design

`scripts/seed.ts` creates a league administrator with a published password and
refuses to run when `NODE_ENV=production`. That guard is correct and should not
be weakened.

To get the sample data into staging, run the scripts **from your machine** —
where `NODE_ENV` is `development` — pointed at the staging database:

```bash
SEED_DATABASE_URL='postgresql://postgres:<superuser>@<host>:<port>/railway' npm run db:seed:reset
```

> `db:seed:reset` **truncates every table first.** Safe on a fresh staging
> database, destructive on anything else. Never point it at production.

Then the sample history:

```bash
SEED_DATABASE_URL='postgresql://postgres:<superuser>@<host>:<port>/railway' npx tsx scripts/sample-history.ts
```

…followed by the three `import-legacy.ts` runs it prints, and
`scripts/check-import.ts` to confirm 9/9 tables still match.

**Change the demo administrator's password immediately** if the staging URL is
reachable by anyone but you. It is published in `.env.example` and in this
repository's history.

---

## Deploy

1. Create a Railway project; add **PostgreSQL** and **Redis**.
2. Run the role SQL from §2 against the new database as the superuser.
3. Connect the repository. Railway reads `railway.json` and builds the Dockerfile.
4. Set the service variables:

   | Variable | Value |
   |---|---|
   | `POSTGRES_URL` | `postgresql://app_user:…` — **not** the superuser |
   | `MIGRATION_DATABASE_URL` | `postgresql://migrator:…` |
   | `REDIS_URL` | Railway's Redis URL |
   | `BETTER_AUTH_SECRET` | `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
   | `BETTER_AUTH_URL` | `https://your-app.up.railway.app` |
   | `DEFAULT_ORG_SLUG` | `kelowna` |

   `NODE_ENV` and `PORT` are set by the Dockerfile. Do not override them —
   `NODE_ENV=development` makes the logger reach for `pino-pretty`, which is
   deliberately absent from the production image, and the container will crash.

5. Migrate, from your machine:

   ```bash
   MIGRATION_DATABASE_URL='postgresql://migrator:…' npm run db:migrate
   ```

   Expect `RLS policies applied to 41 tables` and
   `migration and security verification complete`. If the security verification
   fails, stop — do not deploy around it.

6. Register the hostname (§1), then seed (§3).
7. Deploy, and confirm:

   ```bash
   curl -s https://your-app.up.railway.app/api/healthz
   ```

   Expect `{"status":"ok","database":{"ok":true,…}}`. A `degraded` response means
   `POSTGRES_URL` is wrong.

8. Re-run Lighthouse against the real URL. The local production build scored
   97–99 performance and 100 accessibility, but `plan.md` §6 also sets a
   *separate* budget of **LCP under 1s on simulated 4G** which localhost measured
   at 2.0–2.6s. That number is only meaningful against real hosting and real
   latency, so it should be re-measured here before Milestone 1 is called done.

---

## What was deliberately not done

**The running development instance was not exposed to the internet.** A tunnel
would have produced a public URL in about a minute, and it was the wrong call:
that instance carries a league administrator whose password is published in this
repository, in-process-memory auth rate limiting that resets per instance, and
none of Phase 14's hardening. A staging URL is worth having; a publicly
reachable admin account with a known password is not.

**No account was created and no deployment was performed.** Creating accounts and
handling credentials is outside what I will do unattended, and a first deploy is
an outward-facing action that should be taken deliberately by the person who owns
the bill and the domain.
