import os from "node:os";
import { OSUtils } from "node-os-utils";

// Realtime-oriented config: disable cache so every poll is a fresh sample.
// node-os-utils v2 returns MonitorResult<T> wrappers.
export const osu = new OSUtils({
  cacheEnabled: false,
  timeout: 8000,
});

function ok<T>(p: Promise<{ success: boolean; data?: T }>): Promise<T | null> {
  return p
    .then((r: any) => (r && r.success ? (r.data as T) : null))
    .catch(() => null);
}

function bytes(v: any): number {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  if (typeof v?.toBytes === "function") {
    try {
      return v.toBytes();
    } catch {
      return 0;
    }
  }
  return 0;
}

// Network throughput state (delta of cumulative counters)
let prevNet = { rx: 0, tx: 0, at: 0 };

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) n = 0;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2)} ${units[i]}`;
}

export function formatRate(bps: number): string {
  return `${formatBytes(bps)}/s`;
}

export function formatUptime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  sec = Math.floor(sec);
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/**
 * Normalize a raw uptime value of unknown unit to seconds.
 *
 * node-os-utils `system.uptime()` documents milliseconds, but the Linux
 * adapter already converts /proc/uptime seconds -> ms and SystemMonitor
 * multiplies by 1000 a second time, so in practice we receive ms*1000
 * (i.e. ~1e6 per real second). The old `> 1e9 ? /1000` heuristic only
 * kicked in after ~11 days, inflating ordinary minute/hour uptimes by
 * ~1000x (22min displayed as 15d).
 *
 * Handles seconds, milliseconds, and double-converted ms*1000. When the
 * native `os.uptime()` reference is available, the candidate closest to it
 * wins; otherwise magnitude heuristics apply.
 */
export function normalizeUptimeSec(raw: unknown, nativeSec?: number): number {
  const v = typeof raw === "number" ? raw : Number.NaN;
  const nativeOk =
    typeof nativeSec === "number" && Number.isFinite(nativeSec) && nativeSec >= 0;
  if (!Number.isFinite(v) || v < 0) return nativeOk ? nativeSec! : 0;
  if (nativeOk) {
    const candidates = [v, v / 1000, v / 1e6];
    let best = nativeSec!;
    let bestDiff = Infinity;
    for (const c of candidates) {
      if (!Number.isFinite(c) || c < 0) continue;
      const diff = Math.abs(c - nativeSec!);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = c;
      }
    }
    // If even the best candidate disagrees wildly with the kernel value,
    // trust the kernel (same /proc/uptime source, no lib conversions).
    if (bestDiff > Math.max(60, nativeSec! * 0.1)) return nativeSec!;
    return best;
  }
  // No native reference — fall back to magnitude heuristics.
  if (v >= 1e12) return v / 1e6; // ms*1000 -> sec
  if (v >= 1e10) return v / 1e6; // ~115 days in ms; as sec impossible -> must be inflated
  if (v >= 1e7) return v / 1000; // ~115 days in sec impossible as sec? 1e7s=115d; as ms=~3h. Prefer ms.
  return v; // assume seconds
}

export interface SystemSnapshot {
  timestamp: number;
  cpu: {
    usage: number; // 0-100
    cores: number[]; // per-core 0-100
    count: number; // logical cores (native os)
    model: string;
    speedMHz: number;
    load1: number;
    load5: number;
    load15: number;
  };
  mem: {
    totalBytes: number;
    freeBytes: number; // native os.freemem()
    usedBytes: number;
    usage: number; // 0-100
    availableBytes: number;
    swapTotalBytes: number;
    swapUsedBytes: number;
    swapUsage: number;
  };
  disk: {
    usage: number; // overall 0-100
    totalBytes: number;
    usedBytes: number;
    availableBytes: number;
    mounts: Array<{
      filesystem: string;
      mountpoint: string;
      totalBytes: number;
      usedBytes: number;
      availableBytes: number;
      usage: number;
    }>;
  };
  net: {
    rxBytes: number; // cumulative totals
    txBytes: number;
    rxRate: number; // bytes/sec (delta)
    txRate: number;
    interfaces: Array<{
      name: string;
      state: string;
      rxBytes: number;
      txBytes: number;
      addresses: string[];
    }>;
  };
  system: {
    hostname: string;
    platform: string; // native os.platform()
    arch: string;
    release: string;
    type: string;
    distro: string;
    uptimeSec: number;
    uptimeFormatted: string;
    bootTime: number;
    loadStatus: string;
    processCount: number;
    username: string;
  };
  processes: Array<{
    pid: number;
    name: string;
    cpu: number;
    memMB: number;
    memPct?: number;
    status?: string;
  }>;
}

export async function collectSnapshot(): Promise<SystemSnapshot> {
  const now = Date.now();

  // ---- native os (synchronous, always available) ----
  const nativeCpus = os.cpus();
  const nativeTotal = os.totalmem();
  const nativeFree = os.freemem();
  const nativeLoad = os.loadavg(); // [1,5,15]
  const nativeUptime = os.uptime();
  let username = "";
  try {
    username = os.userInfo().username;
  } catch {
    username = "";
  }

  // ---- node-os-utils (async, best-effort) ----
  const [
    cpuUsage,
    cpuDetailed,
    cpuInfo,
    cpuLoad,
    memInfo,
    swapInfo,
    diskInfo,
    diskOverview,
    netIfaces,
    netStats,
    procStats,
    topCpu,
    sysInfo,
    sysUptime,
    sysLoad,
  ] = await Promise.all([
    ok<number>(osu.cpu.usage() as any),
    ok<any>(osu.cpu.usageDetailed() as any),
    ok<any>(osu.cpu.info() as any),
    ok<any>(osu.cpu.loadAverage() as any),
    ok<any>(osu.memory.info() as any),
    ok<any>(osu.memory.swap() as any),
    ok<any>(osu.disk.info() as any),
    ok<any>(osu.disk.spaceOverview() as any),
    ok<any[]>(osu.network.interfaces() as any),
    ok<any[]>(osu.network.statsAsync() as any),
    ok<any>(osu.process.stats() as any),
    ok<any[]>(osu.process.topByCpu(8) as any),
    ok<any>(osu.system.info() as any),
    ok<any>(osu.system.uptime() as any),
    ok<any>(osu.system.load() as any),
  ]);

  // CPU
  let cores: number[] = [];
  if (cpuDetailed) {
    if (Array.isArray((cpuDetailed as any).cores)) {
      cores = (cpuDetailed as any).cores.map((n: number) =>
        Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0
      );
    }
  }
  if (cores.length === 0) {
    const byCore = await ok<number[]>(osu.cpu.usageByCore() as any).catch(
      () => null
    );
    if (Array.isArray(byCore)) cores = byCore.map((n) => Math.min(100, Math.max(0, n ?? 0)));
  }
  const usage =
    typeof cpuUsage === "number" && Number.isFinite(cpuUsage)
      ? Math.min(100, Math.max(0, cpuUsage))
      : typeof (cpuDetailed as any)?.overall === "number"
        ? (cpuDetailed as any).overall
        : 0;

  const firstCpu = nativeCpus[0];
  const model = (cpuInfo as any)?.model || firstCpu?.model || "Unknown CPU";
  const speedMHz =
    (cpuInfo as any)?.speed && Number.isFinite((cpuInfo as any).speed)
      ? (cpuInfo as any).speed
      : firstCpu?.speed || 0;

  const load1 = (cpuLoad as any)?.load1 ?? (sysLoad as any)?.load1 ?? nativeLoad[0] ?? 0;
  const load5 = (cpuLoad as any)?.load5 ?? (sysLoad as any)?.load5 ?? nativeLoad[1] ?? 0;
  const load15 = (cpuLoad as any)?.load15 ?? (sysLoad as any)?.load15 ?? nativeLoad[2] ?? 0;

  // Memory — prefer osu.memory.info, fall back to native os
  let totalBytes = nativeTotal;
  let availableBytes = nativeFree;
  let usedBytes = nativeTotal - nativeFree;
  let memUsage = nativeTotal > 0 ? (usedBytes / nativeTotal) * 100 : 0;
  if (memInfo) {
    totalBytes = bytes((memInfo as any).total) || nativeTotal;
    availableBytes = bytes((memInfo as any).available) || nativeFree;
    usedBytes = bytes((memInfo as any).used);
    if (!usedBytes && totalBytes && availableBytes != null)
      usedBytes = totalBytes - availableBytes;
    if (typeof (memInfo as any).usagePercentage === "number")
      memUsage = (memInfo as any).usagePercentage;
    else if (totalBytes > 0) memUsage = (usedBytes / totalBytes) * 100;
  }
  const swapTotalBytes = bytes((swapInfo as any)?.total);
  const swapUsedBytes = bytes((swapInfo as any)?.used);
  const swapUsage =
    typeof (swapInfo as any)?.usagePercentage === "number"
      ? (swapInfo as any).usagePercentage
      : swapTotalBytes > 0
        ? (swapUsedBytes / swapTotalBytes) * 100
        : 0;

  // Disk
  const mounts =
    (Array.isArray(diskInfo) ? diskInfo : []).map((d: any) => {
      const total = bytes(d.total);
      const avail = bytes(d.available);
      const used = bytes(d.used) || (total && avail != null ? total - avail : 0);
      return {
        filesystem: String(d.filesystem ?? d.device ?? "?"),
        mountpoint: String(d.mountpoint ?? d.mount ?? "?"),
        totalBytes: total,
        usedBytes: used,
        availableBytes: avail,
        usage:
          typeof d.usagePercentage === "number"
            ? d.usagePercentage
            : total > 0
              ? (used / total) * 100
              : 0,
      };
    }) ?? [];
  const diskTotal = bytes((diskOverview as any)?.total) || mounts.reduce((a, m) => a + m.totalBytes, 0);
  const diskAvail = bytes((diskOverview as any)?.available) || mounts.reduce((a, m) => a + m.availableBytes, 0);
  const diskUsed = bytes((diskOverview as any)?.used) || diskTotal - diskAvail;
  const diskUsage =
    typeof (diskOverview as any)?.usagePercentage === "number"
      ? (diskOverview as any).usagePercentage
      : diskTotal > 0
        ? (diskUsed / diskTotal) * 100
        : mounts.length > 0
          ? mounts.reduce((a, m) => a + m.usage, 0) / mounts.length
          : 0;

  // Network — join interfaces + stats by name
  const statsByName = new Map<string, any>();
  if (Array.isArray(netStats)) {
    for (const s of netStats) {
      const key = String(s.interface ?? s.name ?? "");
      if (key) statsByName.set(key, s);
    }
  }
  const ifaces = (Array.isArray(netIfaces) ? netIfaces : []).map((i: any) => {
    const name = String(i.name ?? i.interface ?? "?");
    const st = statsByName.get(name);
    const rx = bytes(st?.rxBytes) || bytes((st as any)?.rxbytes);
    const tx = bytes(st?.txBytes) || bytes((st as any)?.txbytes);
    const addrs: string[] = [];
    if (Array.isArray(i.addresses)) {
      for (const a of i.addresses) {
        if (typeof a === "string") addrs.push(a);
        else if (a?.address) addrs.push(String(a.address));
      }
    } else if (typeof i.ip === "string") addrs.push(i.ip);
    return {
      name,
      state: String(i.state ?? i.status ?? (i.isUp === false ? "down" : "up")),
      rxBytes: rx,
      txBytes: tx,
      addresses: addrs.slice(0, 4),
    };
  });
  const rxBytes = ifaces.reduce((a, i) => a + i.rxBytes, 0);
  const txBytes = ifaces.reduce((a, i) => a + i.txBytes, 0);
  let rxRate = 0;
  let txRate = 0;
  if (prevNet.at > 0 && now > prevNet.at) {
    const dt = (now - prevNet.at) / 1000;
    if (rxBytes >= prevNet.rx) rxRate = (rxBytes - prevNet.rx) / dt;
    if (txBytes >= prevNet.tx) txRate = (txBytes - prevNet.tx) / dt;
  }
  prevNet = { rx: rxBytes, tx: txBytes, at: now };

  // System — os.uptime() (seconds, straight from the kernel) is authoritative.
  // node-os-utils system.uptime() double-converts to ms*1000 on Linux, and its
  // bootTime derives from that inflated value, so recompute bootTime locally
  // to keep the two consistent.
  const uptimeSec =
    typeof (sysUptime as any)?.uptime === "number"
      ? normalizeUptimeSec((sysUptime as any).uptime, nativeUptime)
      : nativeUptime;
  const bootTime = now - uptimeSec * 1000;

  // Processes (top by CPU) — primary: node-os-utils; fallback: /proc scan
  // (osu returns [] in locked-down containers where `ps` is unavailable)
  let processes = (Array.isArray(topCpu) ? topCpu : [])
    .slice(0, 8)
    .map((p: any) => ({
      pid: Number(p.pid ?? 0),
      name: String(p.name ?? p.command ?? "?"),
      cpu: Number(p.cpuUsage ?? p.cpu ?? 0),
      memMB: bytes(p.memoryUsage ?? p.mem) / 1024 / 1024,
      memPct: typeof p.memoryPercentage === "number" ? p.memoryPercentage : undefined,
      status: p.status ? String(p.status) : undefined,
    }));
  let procTotal = Number((procStats as any)?.total ?? 0);

  if (processes.length === 0) {
    try {
      const { readdirSync, readFileSync } = await import("node:fs");
      const entries = readdirSync("/proc");
      const pids = entries.filter((e) => /^\d+$/.test(e));
      procTotal = pids.length;
      const rows: typeof processes = [];
      for (const pid of pids.slice(0, 60)) {
        try {
          const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
          const statusTxt = readFileSync(`/proc/${pid}/status`, "utf8");
          const nameM = statusTxt.match(/^Name:\s*(.+)$/m);
          const vmM = statusTxt.match(/^VmRSS:\s*(\d+)\s*kB/m);
          const stateM = statusTxt.match(/^State:\s*(\S)/m);
          rows.push({
            pid: Number(pid),
            name: (cmd || nameM?.[1]?.trim() || "?").slice(0, 60),
            cpu: 0,
            memMB: vmM ? Number(vmM[1]) / 1024 : 0,
            status: stateM?.[1],
          });
        } catch {
          /* process vanished / no permission — skip */
        }
      }
      rows.sort((a, b) => b.memMB - a.memMB);
      processes = rows.slice(0, 8);
    } catch {
      /* /proc unavailable (non-Linux) — keep osu result */
    }
  }

  return {
    timestamp: now,
    cpu: {
      usage,
      cores,
      count: (cpuInfo as any)?.logical ?? (cpuInfo as any)?.cores ?? nativeCpus.length,
      model,
      speedMHz,
      load1,
      load5,
      load15,
    },
    mem: {
      totalBytes,
      freeBytes: nativeFree,
      usedBytes,
      usage: Math.min(100, Math.max(0, memUsage)),
      availableBytes,
      swapTotalBytes,
      swapUsedBytes,
      swapUsage: Math.min(100, Math.max(0, swapUsage)),
    },
    disk: {
      usage: Math.min(100, Math.max(0, diskUsage)),
      totalBytes: diskTotal,
      usedBytes: diskUsed,
      availableBytes: diskAvail,
      mounts: mounts.slice(0, 12),
    },
    net: { rxBytes, txBytes, rxRate, txRate, interfaces: ifaces.slice(0, 12) },
    system: {
      hostname: (sysInfo as any)?.hostname || os.hostname(),
      platform: `${os.platform()} / ${(sysInfo as any)?.distro || (sysInfo as any)?.platform || os.type()}`,
      arch: (sysInfo as any)?.arch || os.arch(),
      release: (sysInfo as any)?.release || os.release(),
      type: (sysInfo as any)?.platform || os.type(),
      distro: String((sysInfo as any)?.distro ?? os.type()),
      uptimeSec,
      uptimeFormatted: formatUptime(uptimeSec),
      bootTime,
      loadStatus: String((sysLoad as any)?.status ?? "unknown"),
      processCount: procTotal || processes.length || 0,
      username,
    },
    processes,
  };
}
