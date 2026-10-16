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

## Still open

The CPU pulse still reproduces (one burst of 47–75% of a core for about four
minutes was observed during this work, together with 37% disk utilisation and
2.4–5.0 s WebUI responses). It is no longer continuous, so it needs in-process
attribution rather than more guessing: the `inspect-relay` skill now ships
`probes/cpu-pulse.ts`, which profiles the worker through Bun's `node:inspector`
session while the burn is happening — no restart and no `--inspect` flag — and
publishes the hottest frames next to the thread-level CPU split, the event loop
lag, and the heap object counts.
