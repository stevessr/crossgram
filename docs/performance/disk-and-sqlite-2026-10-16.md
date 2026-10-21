# Disk pressure and SQLite tuning on the production host — 2026-10-16

## Host

Dedicated VPS, `161.118.236.41`: 2 vCPU, 962 MiB RAM, one 50 GiB volume that
reports `ROTA=1` (`BlockVolume`), i.e. a rotational disk shared with the other
tenants of the box (`ace` panel, `cloudflared`, journald, and until today a
headless QQNT bridge). The same disk carries the 8 GiB swap file.

## Symptom

Clients intermittently show "connecting" and reconnect in storms. On the relay
side those minutes look like:

- worker CPU at 43–87% of one core in 1–4 minute bursts (1300–2600 ticks per 30
  seconds), then back to 5–15%,
- `sda` at 87–95% utilisation with 785–2500 read IOPS and `r_await` 1.2–5 ms,
- iowait 30–50% and **steal 30–43%** (the host is oversubscribed),
- 2.2 GiB of 8 GiB swap in use with continuous swap-in (0.3–3.4 MB/s), so page
  faults turn into random reads on the rotational device,
- the worker sitting in `D` (uninterruptible sleep) while the event loop is
  blocked, with zero completed RPCs in the statistics snapshot.

Two earlier fixes took the persistent part of this away: the delivery retention
sweep now seeks its index instead of scanning the whole table (`6853643e`), and
the download queue answers `FLOOD_WAIT_2` so clients back off instead of
retrying immediately (`d7270393`).

## What changed today

### 1. The SQLite driver tunes itself from the memory the host has

The driver patch (`.yarn/patches/@cordisjs-plugin-database-sqlite-*`) now
applies connection pragmas from an adaptive policy instead of a fixed budget
(`9540620b`):

| Pragma | Value | Why |
| --- | --- | --- |
| `synchronous` | `NORMAL` | Drops the fsync from every WAL commit. On a shared rotational disk a commit is a millisecond until it lands next to another tenant's write burst; the cost is the documented trade-off that a power failure can lose the last transactions, not integrity. `synchronous: full` opts back in. |
| `cache_size` | `MemAvailable / 8`, floor 4 MiB, ceiling `cacheSizeKiB` (32 MiB), never above the database | The page cache is anonymous memory: every page it holds is a page the kernel may have to write to swap. Sizing it from the database file, which is the usual advice, is wrong on a host that swaps to a slow disk. |
| `mmap_size` | `min(database, mmapSizeMiB)` (192 MiB) | Mapped pages are clean and file backed, so the kernel reclaims them without swap. On a memory-tight host the mapping should carry the working set. |
| `temp_store` | `MEMORY` | A temp file here costs a random write on a disk that is already at 90%. |
| `wal_autocheckpoint` | 2000 pages | Halves the checkpoint frequency, so fewer commits wait behind a checkpoint flush. |
| `journal_size_limit` | 32 MiB | Bounds the WAL, which keeps the observed WAL at ~8 MiB and recovery short. |

The tuning is re-applied every minute so it follows the memory the rest of the
machine gives back, and `PRAGMA optimize` runs with `analysis_limit = 400` once
a minute after start and every six hours after that. Bounded samples are what
keeps the planner from turning one query into a full scan on a 776 MiB
database — the failure mode that started this investigation.

`autoTune: false` leaves `cache_size` and `mmap_size` at SQLite's defaults for
an operator who wants to size them by hand.

### 2. Memory and I/O priority for the service

- `MemoryMin=200M` and `MemorySwapMax=256M` (runtime drop-in on this host, not
  in the repository template) keep the worker resident; its `VmSwap` is now
  `0 kB` instead of being evicted to the rotational disk.
- `deploy/crossgram.service` now sets `IOSchedulingClass=best-effort` with
  `IOSchedulingPriority=0`, so the relay's few reads do not queue behind a
  neighbour's bulk write.
- The QQNT bridge and its `@mtproto-relay/platform-qqnt` entry were disabled on
  this host, which returned roughly 500 MiB (used memory 719 → 461 MiB) and
  also removed its Chromium profile I/O from the same disk.

## Verification (production, read-only)

```sh
# mmap is per connection, so a mapping in the worker proves it is active
grep crossgram.sqlite /proc/$(pgrep -f worker/main.js)/maps   # 192.0 MiB
ionice -p $(pgrep -f worker/main.js)                          # best-effort: prio 0
grep -E 'VmRSS|VmSwap' /proc/$(pgrep -f worker/main.js)/status # VmSwap: 0 kB
```

A probe opened the same database with the production configuration and read the
pragmas back: `synchronous=1`, `cache_size=-32768`, `mmap_size=201326592`,
`temp_store=2`, `wal_autocheckpoint=2000`, `journal_size_limit=33554432`.

Database state at the time: 776.1 MiB file, 8.0 MiB WAL, ~0.1 MiB free list,
planner statistics present for 52 indexes. Largest tables: 520 468 rows
`mtproto_tl_message_part`, 506 818 `mtproto_im_message`, 506 818
`mtproto_im_message_alias`, 67 994 `mtproto_im_message_reaction`, 58 766
`mtproto_im_media`, 37 768 `mtproto_update_delivery`.

Stability after the change: worker CPU 11–95 ticks per 30 seconds (0.4–1.5% of
one core) with `sda` between 0 and 20%, against 1300–2600 ticks and 87–95%
before. The remaining bursts are a separate problem, still open below.

## io_uring

Checked because it is the obvious way to keep blocking I/O out of the event
loop, and the result is negative for this stack:

- Kernel: 6.12.107 with `io_uring_disabled=0`, and `liburing.so.2` installed —
  the interface is available.
- **Bun 1.4.3 does not use it**: the binary contains no `io_uring` symbols, the
  worker has no `io_uring` file descriptor, and its event loop is epoll based
  with a syscall thread pool (`BUN_FEATURE_FLAG_FORCE_IO_POOL` /
  `DISABLE_IO_POOL` are the only related switches).
- `node:sqlite` / `bun:sqlite` are synchronous by design, and their VFS uses
  `pread`/`pwrite`, not `io_uring`.
- PostgreSQL on this host is 17.11, which has no `io_method`; asynchronous I/O
  with `io_method=io_uring` arrived in PostgreSQL 18.

So nothing in the current runtime can submit `io_uring` requests. What the
tuning above does instead is the same job by other means: keep the relay's I/O
cheap (mmap instead of copy, fewer fsyncs), keep it resident (memory protection
so it is not paged out to the device), and keep it ahead of bulk neighbours
(I/O priority). The remaining path to a real `io_uring` deployment is the
PostgreSQL 18 driver, which the repository already supports
(`deploy/app.production.yml`, `deploy/provision-postgres.sh`,
`@cordisjs/plugin-database-postgres`) and which would move all database I/O off
the event loop entirely.

## Root cause of the pulses

The probe paid for itself on its first run. A pump of 44.7% of a core with an
11.2 s event loop stall profiled a Discord re-sync (`structures/User._patch`,
`managers/ReactionUserManager.fetch`), and the subscription tracer named the
caller exactly:

```
ensure platform=discord session=867403e4
  _enqueueNow        (packages/bridge/src/platform-manager.ts:644)
  _flushReactionBatch (packages/bridge/src/platform-manager.ts:628)
```

Two independent defects made a single Discord reaction re-sync a whole platform
session, forever, while no Telegram client was connected:

1. `_flushReactionBatch` runs two seconds after the event that created the
   batch. The idle reaper can pause the session inside that window, and the
   flush then found no subscription and called `ensure()` — reopening the
   session that was deliberately paused. Each reopen reconnected Discord, the
   reaper paused it again a minute later, and the next reaction repeated it.
   Fixed in `a1d2a4e6`: a coalesced platform update settles without delivery
   when its session is paused, keeping resumption tied to client activity.
2. Every `messageReactionAdd` mapped the reaction context with up to a hundred
   actors per reaction, and each actor is a user fetch plus a discord.js
   structure-cache entry, while a pushed update only carries three. Fixed in
   `2de599a0`: reaction events ask for those three, and paging the full list
   stays a `getMessageReactions` detail RPC.

The bridge's idle warm-up also re-subscribed every paused session hourly to keep
it warm, which on this host costs about a minute of CPU per platform per hour,
so the runtime configuration then set
`bridge.config.lazySync.idleSyncIntervalMs: 86400000` with a one-minute window:
a session still starts on the first client RPC that needs it, and the hourly
storm is gone.

**Update (2026-10-21):** the daily cadence left up to 24h of unsynced
platform messages when no Telegram client was active. The cadence is now
5 minutes — `activeWindowMs: 300000` (a session stays subscribed for 5
minutes after the last client RPC), `idleSyncIntervalMs: 300000`
(one bounded 60s sync window every 5 minutes while idle). Measured cost of
one window is ~35s of bootstrap CPU per platform; at this cadence that is
roughly 12% of a core on average while idle, which the host sustains without
memory or PSI pressure.

Verified afterwards: zero subscription lifecycle events in the 11 minutes that
followed (previously 5–25 per burst), worker CPU back to ~15% of a core, WebUI
responses at 2 ms, and no `ensure` call from the flush path in the tracer.

## Measurement trap

`bun:jsc`'s `heapStats()` walks the heap: 20–100 ms on a small heap, but seconds
once the relay holds a few hundred megabytes. Sampling it once a minute added a
multi-second event loop stall and a visible slice of CPU (31% of one captured
profile was the probe's own `heapStats` call), which is exactly the symptom the
probe was built to measure. The shipped probe therefore uses
`process.memoryUsage()` and lets the profile frames name the allocator.

## Still open

- The shared rotational disk still produces multi-second stalls of its own:
  during the post-fix baseline the volume sat at 82–98% utilisation for five
  minutes while the relay's own CPU stayed low, and WebUI requests timed out at
  six seconds. Those minutes belong to whichever tenant is writing, not to the
  relay, and no application change removes them.
- The Matrix platform session aborts with `MatrixHttpError: M_UNKNOWN_TOKEN`, so
  the configured `MATRIX_ACCESS_TOKEN` is stale. It retries once per session
  start rather than looping, but the platform stays unusable until the token is
  replaced or the platform is disabled the way QQNT was.
- PostgreSQL 18 with `io_method=io_uring` remains the only route to real
  asynchronous disk I/O for the database, and it would move every database call
  off the event loop. **Decision (2026-10-17): deferred.** The post-fix host has
  roughly 315 MiB available; PostgreSQL 18 needs about 250 MiB more, which
  would push the box back into swap — the exact failure mode this round
  removed. The remaining stalls trace to co-tenant disk saturation, which
  io_uring does not fix, and the tuned SQLite driver now keeps the WAL bounded
  (8 MiB) with mmap-served reads. Revisit if the database is ever shown to
  stall (e.g. DB-call latency percentiles in a probe) or the host gets more
  memory.
  **Update (2026-10-19): the probe exists now.** The bridge times every
  database call and the statistics dashboard shows DB call rate and P90/P99
  (`/mtproto-statistics`: overview card "Database calls", RPC-tab card
  "Database latency"). Revisit is warranted if DB P99 sustains above RPC P99
  while the co-tenant disk is idle.

