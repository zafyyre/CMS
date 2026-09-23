-- ---------------------------------------------------------------------------
-- Role separation. This is the single thing that makes row-level security work.
--
-- PostgreSQL silently ignores RLS policies for superusers, and for a table's
-- owner unless FORCE ROW LEVEL SECURITY is set. So a system that connects as
-- `postgres` can have perfect-looking policies that protect nothing — every
-- test passes, and production leaks. That is the trap this file exists to avoid.
--
-- Three roles:
--   postgres  — superuser. Used by this init script and by seeding. Never by
--               the running application.
--   migrator  — owns every table, runs migrations, never serves a request.
--   app_user  — owns nothing, not a superuser, no BYPASSRLS. This is what the
--               application connects as, so policies actually bind to it.
--
-- scripts/migrate.ts asserts all of this against pg_catalog on every run and
-- fails the migration if it drifts.
-- ---------------------------------------------------------------------------

CREATE ROLE migrator WITH LOGIN PASSWORD 'migrator_local_pw'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

CREATE ROLE app_user WITH LOGIN PASSWORD 'app_local_pw'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

-- A separate database for integration tests, so a failing test that truncates
-- tables can never destroy development data.
CREATE DATABASE cms_test OWNER postgres;

GRANT CONNECT ON DATABASE cms      TO migrator, app_user;
GRANT CONNECT ON DATABASE cms_test TO migrator, app_user;

-- CREATE on the *database* is distinct from CREATE on a schema, and is what
-- `CREATE SCHEMA` needs. Drizzle's migrator keeps its bookkeeping in its own
-- `drizzle` schema, so migrator requires this. app_user deliberately never
-- gets it: it must not be able to create objects, ever.
GRANT CREATE ON DATABASE cms      TO migrator;
GRANT CREATE ON DATABASE cms_test TO migrator;


-- --- primary database --------------------------------------------------------
\connect cms

CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- fuzzy name matching for search

ALTER SCHEMA public OWNER TO migrator;
GRANT USAGE, CREATE ON SCHEMA public TO migrator;
GRANT USAGE ON SCHEMA public TO app_user;

-- Anything migrator creates later is automatically usable by app_user, but
-- only through DML. app_user can never run DDL, so it can never DROP a POLICY.
ALTER DEFAULT PRIVILEGES FOR ROLE migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES FOR ROLE migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_user;


-- --- test database (identical wiring, so tests exercise the real thing) -------
\connect cms_test

CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER SCHEMA public OWNER TO migrator;
GRANT USAGE, CREATE ON SCHEMA public TO migrator;
GRANT USAGE ON SCHEMA public TO app_user;

ALTER DEFAULT PRIVILEGES FOR ROLE migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES FOR ROLE migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_user;
