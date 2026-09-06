# sysinfo — Realtime System Dashboard

Grafana-style realtime dashboard showing used/free system resources, built with
**Bun**, [`node-os-utils`](https://www.npmjs.com/package/node-os-utils) (v2 API via `OSUtils`)
and the native **`node:os`** module.

## Run

```bash
bun install
bun run index.ts
```

Then open:

| URL | Description |
| --- | ----------- |
| `http://localhost:3000/` | Dashboard UI (React, bundled by Bun from `index.html` + `frontend.tsx`) |
| `http://localhost:3000/api/stats` | One-shot JSON snapshot (REST) |
| `ws://localhost:3000/realtime` | Push stream — one JSON frame per second (`{ "type": "stats", "data": … }`) |

`PORT` env var overrides the default port 3000.

## What is shown

- **CPU** — usage %, per-core bars, model, logical count, load avg (1/5/15)
- **Memory** — used %, used/total, free (`os.freemem()`), available, swap
- **Disk** — overall usage, totals, per-mount table
- **Network** — RX/TX throughput (delta of cumulative counters), totals, per-interface table with addresses
- **System** — hostname, platform/distro, arch, release, uptime, boot time, user, process count
- **Top processes** — via `osu.process.topByCpu(8)`, with a `/proc` fallback in containers where `ps` is unavailable
- **History** — last 60 samples as sparklines + time-series charts (CPU/MEM, RX/TX)

The frontend connects over WebSocket and falls back to HTTP polling (`/api/stats`)
if the socket drops. Sampling interval for the fallback is selectable (1s / 2s / 5s),
and the stream can be paused/resumed.

## Sources per metric

| Metric | `node-os-utils` | `node:os` |
| --- | --- | --- |
| CPU usage / cores / info | `cpu.usage()`, `usageDetailed()`, `usageByCore()`, `info()` | `cpus()` (model, count, fallback) |
| Load average | `cpu.loadAverage()`, `system.load()` | `loadavg()` (fallback) |
| Memory | `memory.info()`, `memory.swap()` | `totalmem()`, `freemem()` |
| Disk | `disk.info()`, `disk.spaceOverview()` | — |
| Network | `network.interfaces()`, `network.statsAsync()` | `networkInterfaces()`-style addresses |
| System | `system.info()`, `system.uptime()` | `hostname()`, `platform()`, `arch()`, `release()`, `type()`, `uptime()`, `userInfo()` |
| Processes | `process.topByCpu()`, `process.stats()` | `/proc` scan fallback |

## Files

- `index.ts` — `Bun.serve()` server: routes (`/`, `/api/stats`, `/health`) + `/realtime` WebSocket broadcast @1s
- `stats.ts` — snapshot collector merging `node-os-utils` results with `node:os` data
- `index.html` / `frontend.tsx` / `styles.css` — dashboard UI (no external chart libs, canvas-rendered)
