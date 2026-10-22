# PGX backend (experimental, PostgreSQL wire protocol)

CrossGram can connect to [PGX](https://github.com/pgrundev/pgx) through its existing
**@cordisjs/plugin-database-postgres** driver. PGX is a **database server**, not a
Node.js driver dependency. No extra CrossGram SQL implementation, build flag or
package is required.

**Do not use PGX v0.1 as CrossGram's production system of record.** As of
2026-10-23 the project documents an ephemeral profile with fsync disabled, no
crash-safety guarantee, and one process as a shared failure domain. It is
intended for disposable databases in development, CI and previews. CrossGram's
default production backend remains PostgreSQL.

## Enabling for a disposable CrossGram deployment

1. Install PGX following its upstream documentation and start a separate PGX
   runtime (run **pgx run**). **pgx url app** displays the actual connection parameters.
   Keep the runtime alive and accessible to the CrossGram process; PGX is not
   embedded into the application.
2. Put the parameters from **your own** PGX connection URL into the existing
   root-owned, mode-0600 /etc/crossgram.env file (or environment variables
   supplied by your process manager). For example:

   ~~~dotenv
   CROSSGRAM_PGX_HOST=127.0.0.1
   CROSSGRAM_PGX_PORT=5432
   CROSSGRAM_PGX_USER=postgres
   CROSSGRAM_PGX_PASSWORD=replace_with_your_PGX_password
   CROSSGRAM_PGX_DATABASE=app
   ~~~

   Values above are examples; do not assume PGX uses port 5432 or these
   credentials. Keep the database on localhost or a private trusted network.
   Use a permanent database (e.g. app), not a TTL-expiring clone for any
   data that must survive sessions.

3. On the Linux installation, select the dedicated PGX entry, then restart:

   ~~~sh
   sudo node /opt/crossgram/deploy/select-database.mjs pgx
   sudo systemctl restart crossgram.service
   ~~~

   This disables **database-postgres** and enables **database-pgx**. Both entries
   use the same Cordis PostgreSQL driver; the PGX entry has **max: 2** to avoid
   an oversized application connection pool on 1–2 vCPU hosts.

   The selector edits only the two known entries, atomically preserving owner
   and mode. It refuses unknown/missing entries and never touches the database
   files. Updates retain the selected backend.

4. To switch **the connection configuration** back:

   ~~~sh
   sudo node /opt/crossgram/deploy/select-database.mjs postgres
   sudo systemctl restart crossgram.service
   ~~~

   **Switching does not migrate data.** PostgreSQL and PGX databases contain
   independent state. Plan explicit backups and a validated dump/restore if
   moving data, and never repoint live traffic at an empty database without
   accepting that its history and mappings will differ.

Local development can instead enable the disabled **database-pgx** entry in
app.yml and disable the SQLite entry. Never run two Cordis database drivers
simultaneously.

## Compatibility and resource checks

Before using PGX with a new CrossGram schema, run the existing PostgreSQL
Cordis-driver contract test *against a disposable PGX database*:

~~~sh
pgx create crossgram_e2e --ttl 2h
CROSSGRAM_PGX_TEST_URL="$(pgx url crossgram_e2e)" \
  corepack yarn vitest run deploy/postgres-driver.e2e.test.ts
~~~

Set CROSSGRAM_POSTGRES_TEST_URL in a separate run to compare ordinary
PostgreSQL. The test exercises schema preparation twice, long identifiers,
uniqueness, JSON, binary values, timestamps and a committed transaction. These
are integration tests and require a reachable running server.

For a meaningful 1C2T1G comparison, run the *same* CrossGram workload for
each backend and record total RSS (CrossGram + database server), working-set
memory, connection count, CPU, p50/p95 query latency, disk write/fsync rate,
and power-loss/crash recovery behavior. Compare at equal database size, cache
warmth and concurrent adapter counts, not only per-database idle memory.

PGX reports low *incremental* memory for hundreds of isolated databases, but
this does **not** establish lower total RSS than PostgreSQL for one long-lived
CrossGram database. Its published data shows slower individual point queries
and large scans in some workloads. Measure before changing the production
backend. PostgreSQL's lower pool size and memory tuning, or a properly tuned
SQLite backend, may be preferable for a single small instance.

PGX itself is AGPL-3.0 licensed. Review its license before distributing a
modified PGX server or a combined deployment.

Upstream references:
- https://github.com/pgrundev/pgx
- https://github.com/pgrundev/pgx/blob/main/docs/pgx/v0.1-readiness.md
- https://github.com/pgrundev/pgx/blob/main/docs/pgx/linux-results.md
