-- Runs once on first container boot (Postgres entrypoint executes *.sql in this dir).
-- The main `inkpath` DB is created via POSTGRES_DB; this adds the test database that
-- test/setup.ts targets by default (postgresql://...:5432/inkpath_test).
CREATE DATABASE inkpath_test;
