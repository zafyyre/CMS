# League CMS

Competition management for amateur soccer leagues. Multi-tenant: one codebase and
one database serving many leagues, each with its own website.

**Status: Track A (Foundation) complete.** 30 tables, 67 tests, no fixtures or
results yet — those are Phase 3.

---

## Running it

Requires **Node 22+** and **Docker Desktop** (running).

```bash
npm install
cp .env.example .env
npm run db:up
npm run db:migrate
npm run db:migrate:test
npm run db:seed
npm run dev
```

Open **http://localhost:3000** — you should see the Kelowna Metro League with its
divisions, a cup, and an honours board. And **http://localhost:3000/api/healthz**
should return `{"status":"ok",...}`.

The seed is fictional demo data: invented clubs named after Kelowna
neighbourhoods and nearby Okanagan communities. Replace it with real data when
you have it; nothing in the schema depends on any of it.

### If `npm run dev` says the port is taken

Something else is on 3000. `npm run dev -- -p 3001`.

### If the database will not connect

Postgres is published on **5433**, not 5432 — deliberately. This machine runs a
native PostgreSQL 18 Windows service already bound to `0.0.0.0:5432`, and Docker
does not displace it, so an app pointed at 5432 silently talks to the wrong
server. Check what is actually listening:

```bash
docker compose ps
```

Both containers should say `healthy`, with postgres on `0.0.0.0:5433->5432/tcp`.

### Re-seeding

To wipe the seeded data and rebuild it, without touching the schema:

```bash
npm run db:seed:reset
```

> Use that script rather than `npm run db:seed -- --reset`. On Windows with
> PowerShell, npm does not forward arguments after `--` to the script — the flag
> is silently dropped and you end up with a SECOND league alongside the first
> rather than a clean one. There is a dedicated script for every flag for
> exactly this reason.

### Starting completely fresh

```bash
npm run db:nuke
npm run db:up
npm run db:migrate
npm run db:migrate:test
npm run db:seed
```

`db:nuke` deletes the volumes, so the role-setup scripts in `db/init` run again
from scratch. This whole sequence is tested and takes well under a minute.

---

## Checking it works

```bash
npm run verify
```

Runs typecheck → lint → tenancy guard → 67 tests. Everything must pass.

| Command | What it does |
|---|---|
| `npm run verify` | The full gate. Run this before committing. |
| `npm test` | Tests only |
| `npm run test:watch` | Tests, re-running on change |
| `npm run typecheck` | TypeScript only |
| `npm run guard` | Static check for tenancy bypasses |
| `npm run build` | Production build |
| `npm run db:studio` | Browse the database in a GUI |

### Proving the security is real, not decorative

The migration re-asserts this on every run and **fails** if anything drifted, but
you can check by hand:

```bash
docker exec cms_postgres psql -U postgres -d cms -c "select rolname, rolsuper, rolbypassrls from pg_roles where rolname in ('app_user','migrator');"
```

Both roles must show `f` and `f`. This is the thing that matters most: PostgreSQL
**ignores row-level security for superusers**, so an app connecting as `postgres`
would have perfect-looking policies protecting nothing.

```bash
# Every league-scoped table must have RLS enabled AND forced
docker exec cms_postgres psql -U postgres -d cms -c "select relname, relrowsecurity, relforcerowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' order by relname;"

# The audit log must have only SELECT and INSERT policies — no UPDATE, no DELETE
docker exec cms_postgres psql -U postgres -d cms -c "select polname, polcmd from pg_policy p join pg_class c on c.oid=p.polrelid where c.relname='audit_log';"
```

### Seeing multi-tenancy work

Each league is reached by hostname. The seed registers `kelowna.localhost`:

```bash
curl -H "Host: kelowna.localhost" http://localhost:3000/     # the demo league
curl -H "Host: nobody.invalid"    http://localhost:3000/     # "No league configured"
```

`localhost` falls back to `DEFAULT_ORG_SLUG` from `.env`.

---

## Architecture

### Isolation is enforced by the database, not by remembering to filter

Every league-scoped table carries `org_id`, and PostgreSQL row-level security
compares it to a transaction-local setting. The application connects as
`app_user`: not a superuser, no `BYPASSRLS`, owns no tables — so it cannot turn
the policies off. Tables are owned by `migrator`, which never serves a request.

The only sanctioned data path:

```ts
await withOrg(orgId, async (tx) => tx.select().from(clubs));
```

`orgId` is a **branded type** that can only be minted from the resolved request
hostname or an authenticated principal — so an id lifted from a URL will not
compile. Policies carry `WITH CHECK` as well as `USING`, so a write cannot stamp
a row with another league's id.

Policies are **generated** from a list in `src/db/policies.ts` and re-applied on
every migration, then verified against `pg_catalog`. A new table carrying
`org_id` that nobody listed fails the migration.

### Authorization is a separate layer

`can()` in `src/server/authz` is pure — no I/O — and answers "is this principal
allowed?". RLS answers "can they reach this row?". Both must pass; each is the
backstop for the other failing.

Roles are **scoped** (a club admin administers one club) and carry a **validity
window**, so a term that ended stops conferring authority without anyone deleting
a row. Admin-tier roles cannot write until a TOTP second factor is enrolled.

### A competition is a line, not a category

- **series** — the perpetual thing ("Division 2", founded 1981)
- **edition** — this season's running of it. `tier` lives here, so restructuring
  the pyramid is an INSERT, not a migration
- **stages** and **groups** — how it is actually played. A division running as
  two parallel sections is two groups, and the play-off between the section
  winners is described as data
- **progression rules** — promotion and relegation as rows, which is what they
  always were
- **honours** — a trophy is an entity with a lineage of winners, so "who won this
  in 2019" is an ordinary query

There is deliberately **no** `competition_kind` enum. A cup is simply a
competition that sits on no ladder.

### A person is not a user

`persons` is separate from `users`. A player has a name, a date of birth and a
registration history long before they ever create a login, and most never will.

---

## Layout

```
db/init/            role separation + extensions (runs once, on first start)
drizzle/            generated migrations
scripts/
  migrate.ts        migrations + RLS policies + catalog verification
  seed.ts           a fictional demo league
  guard-tenancy.ts  static guard against tenancy bypass
src/
  app/              routes
  components/       UI, incl. status-pill (never colour alone)
  db/               client, schema, withOrg/withSystem, policy generation
  server/
    auth/           better-auth wiring + principal builder
    authz/          roles, permission matrix, can()
    services/       data access; no component touches the database
    tenancy/        hostname → league
tests/
  unit/             permission matrix (37 tests)
  integration/      isolation, audit immutability, role grants (30 tests)
```

---

## Not built yet

- **No sign-in UI or admin screens.** The auth API works; there are no pages.
- **No rate limiting** on `/api/auth/*` — needs Redis, which is Phase 7. This is
  the most meaningful remaining gap.
- **Fixtures, results, standings** — Phase 3 and 4.
- Session tokens are stored in plaintext (inherent to better-auth). No injection
  path exists today; the control is that nothing but the app reaches the database.
