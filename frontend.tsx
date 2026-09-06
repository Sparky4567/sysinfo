import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

interface Snapshot {
  timestamp: number;
  cpu: { usage: number; cores: number[]; count: number; model: string; speedMHz: number; load1: number; load5: number; load15: number };
  mem: { totalBytes: number; freeBytes: number; usedBytes: number; usage: number; availableBytes: number; swapTotalBytes: number; swapUsedBytes: number; swapUsage: number };
  disk: { usage: number; totalBytes: number; usedBytes: number; availableBytes: number; mounts: Array<{ filesystem: string; mountpoint: string; totalBytes: number; usedBytes: number; availableBytes: number; usage: number }> };
  net: { rxBytes: number; txBytes: number; rxRate: number; txRate: number; interfaces: Array<{ name: string; state: string; rxBytes: number; txBytes: number; addresses: string[] }> };
  system: { hostname: string; platform: string; arch: string; release: string; type: string; distro: string; uptimeSec: number; uptimeFormatted: string; bootTime: number; loadStatus: string; processCount: number; username: string };
  processes: Array<{ pid: number; name: string; cpu: number; memMB: number; memPct?: number; status?: string }>;
}

const HISTORY_N = 60;

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2)} ${u[i]}`;
}
function fmtRate(n: number) { return `${fmtBytes(n)}/s`; }
function color(pct: number) {
  if (pct >= 90) return "#f26d6d";
  if (pct >= 70) return "#e5b545";
  if (pct >= 40) return "#5794ff";
  return "#3fce8f";
}

/* ---------- canvas helpers ---------- */
function drawSpark(canvas: HTMLCanvasElement, series: number[], stroke: string) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  if (series.length < 2) return;
  const max = Math.max(100, ...series);
  ctx.beginPath();
  series.forEach((v, i) => {
    const x = (i / (series.length - 1)) * w;
    const y = h - (v / max) * (h - 4) - 2;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = stroke; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, stroke + "55"); g.addColorStop(1, stroke + "00");
  ctx.fillStyle = g; ctx.fill();
}

function Spark({ data, c }: { data: number[]; c: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => { if (ref.current) drawSpark(ref.current, data, c); }, [data, c]);
  return <canvas ref={ref} />;
}

function TimeChart({ a, b, labelA, labelB, ca, cb, max = 100, unit = "%" }: {
  a: number[]; b: number[]; labelA: string; labelB: string; ca: string; cb: string; max?: number; unit?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    canvas.width = w * dpr; canvas.height = h * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    // gridlines
    ctx.strokeStyle = "rgba(139,147,167,0.15)"; ctx.lineWidth = 1;
    ctx.fillStyle = "#8b93a7"; ctx.font = "10px sans-serif";
    const steps = 4;
    for (let i = 0; i <= steps; i++) {
      const y = (i / steps) * (h - 20) + 4;
      ctx.beginPath(); ctx.moveTo(30, y); ctx.lineTo(w, y); ctx.stroke();
      const val = max - (i / steps) * max;
      ctx.fillText(unit === "%" ? `${Math.round(val)}` : fmtBytes(val), 2, y + 3);
    }
    const plot = (series: number[], stroke: string) => {
      if (series.length < 2) return;
      ctx.beginPath();
      series.forEach((v, i) => {
        const x = 30 + (i / (HISTORY_N - 1)) * (w - 34);
        const y = 4 + (1 - Math.min(1, v / max)) * (h - 24);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = stroke; ctx.lineWidth = 1.8; ctx.stroke();
    };
    plot(b, cb);
    plot(a, ca);
  }, [a, b, ca, cb, max, unit]);

  return (
    <>
      <canvas ref={ref} className="chart" />
      <div className="legend">
        <span><span className="swatch" style={{ background: ca }} />{labelA}: <b>{a.length ? a[a.length - 1]!.toFixed(1) : "—"}{unit}</b></span>
        <span><span className="swatch" style={{ background: cb }} />{labelB}: <b>{b.length ? b[b.length - 1]!.toFixed(1) : "—"}{unit}</b></span>
      </div>
    </>
  );
}

/* ---------- main app ---------- */
function App() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [history, setHistory] = useState<Snapshot[]>([]);
  const [status, setStatus] = useState<"live" | "polling" | "down" | "paused">("down");
  const [paused, setPaused] = useState(false);
  const [intervalMs, setIntervalMs] = useState(1000);
  const pausedRef = useRef(false);
  pausedRef.current = paused;

  useEffect(() => {
    let ws: WebSocket | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    let closed = false;

    const push = (s: Snapshot) => {
      if (pausedRef.current) return;
      setSnap(s);
      setHistory((h) => [...h.slice(-HISTORY_N + 1), s]);
    };

    const startPolling = () => {
      if (poll) return;
      setStatus((s) => (s === "paused" ? s : "polling"));
      const tick = async () => {
        try {
          const r = await fetch("/api/stats");
          if (!r.ok) throw new Error("bad status");
          push(await r.json());
          setStatus(pausedRef.current ? "paused" : "polling");
        } catch {
          if (!closed) setStatus("down");
        }
      };
      tick();
      poll = setInterval(tick, intervalMs);
    };

    const connect = () => {
      try {
        const proto = location.protocol === "https:" ? "wss" : "ws";
        ws = new WebSocket(`${proto}://${location.host}/realtime`);
      } catch {
        startPolling();
        return;
      }
      ws.onopen = () => { if (!closed) setStatus(pausedRef.current ? "paused" : "live"); };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === "stats" && msg.data) {
            push(msg.data as Snapshot);
            setStatus(pausedRef.current ? "paused" : "live");
          }
        } catch {}
      };
      ws.onerror = () => { try { ws?.close(); } catch {} };
      ws.onclose = () => {
        ws = null;
        if (!closed) setTimeout(() => { if (!closed && !ws) { connect(); } }, 2500);
        if (!closed) startPolling(); // keep data flowing until WS recovers
      };
    };

    connect();
    return () => {
      closed = true;
      try { ws?.close(); } catch {}
      if (poll) clearInterval(poll);
    };
  }, [intervalMs]);

  useEffect(() => {
    setStatus((s) => {
      if (paused) return "paused";
      return s === "paused" ? "down" : s;
    });
  }, [paused]);

  const cpuHist = history.map((h) => h.cpu.usage);
  const memHist = history.map((h) => h.mem.usage);
  const rxHist = history.map((h) => h.net.rxRate);
  const txHist = history.map((h) => h.net.txRate);
  const netMax = Math.max(1024 * 1024, ...rxHist, ...txHist) * 1.2;

  return (
    <>
      <header className="topbar">
        <div className="logo">📊</div>
        <div className="title">
          <h1>Sysinfo · Realtime System Dashboard</h1>
          <p>
            {snap ? `${snap.system.hostname} · ${snap.system.platform} · ${snap.system.arch}` : "connecting…"}
            {snap ? ` · boot ${new Date(snap.system.bootTime).toLocaleString()}` : ""}
          </p>
        </div>
        <div className="spacer" />
        <div className="controls">
          <span className="conn">
            <span className={`dot ${status === "live" ? "live" : status === "paused" ? "paused" : status === "polling" ? "paused" : "down"}`} />
            {status === "live" ? "LIVE · ws" : status === "polling" ? "POLLING · http" : status === "paused" ? "PAUSED" : "RECONNECTING"}
          </span>
          <select value={intervalMs} onChange={(e) => setIntervalMs(Number(e.target.value))} title="Polling interval fallback">
            <option value={1000}>1s</option>
            <option value={2000}>2s</option>
            <option value={5000}>5s</option>
          </select>
          <button className={paused ? "active" : ""} onClick={() => setPaused((p) => !p)}>
            {paused ? "▶ Resume" : "⏸ Pause"}
          </button>
        </div>
      </header>

      <main>
        {!snap && <div className="panel"><p className="hint">Waiting for first sample from <span className="mono">ws://…/realtime</span> (fallback <span className="mono">/api/stats</span>)…</p></div>}

        {snap && (
          <>
            <section className="cards">
              <div className="card">
                <div className="label">CPU usage</div>
                <div className="value" style={{ color: color(snap.cpu.usage) }}>{snap.cpu.usage.toFixed(1)}%</div>
                <div className="sub">{snap.cpu.count} cores · load {snap.cpu.load1.toFixed(2)} / {snap.cpu.load5.toFixed(2)} / {snap.cpu.load15.toFixed(2)}</div>
                <Spark data={cpuHist} c="#5794ff" />
              </div>
              <div className="card">
                <div className="label">Memory used</div>
                <div className="value" style={{ color: color(snap.mem.usage) }}>{snap.mem.usage.toFixed(1)}%</div>
                <div className="sub">{fmtBytes(snap.mem.usedBytes)} / {fmtBytes(snap.mem.totalBytes)} · free {fmtBytes(snap.mem.freeBytes)}</div>
                <Spark data={memHist} c="#3fce8f" />
              </div>
              <div className="card">
                <div className="label">Disk used</div>
                <div className="value" style={{ color: color(snap.disk.usage) }}>{snap.disk.usage.toFixed(1)}%</div>
                <div className="sub">{fmtBytes(snap.disk.usedBytes)} / {fmtBytes(snap.disk.totalBytes)} · {snap.disk.mounts.length} mounts</div>
                <Spark data={history.map((h) => h.disk.usage)} c="#e5b545" />
              </div>
              <div className="card">
                <div className="label">Net ↓ RX</div>
                <div className="value" style={{ fontSize: 22 }}>{fmtRate(snap.net.rxRate)}</div>
                <div className="sub">total {fmtBytes(snap.net.rxBytes)}</div>
                <Spark data={rxHist} c="#4cc9f0" />
              </div>
              <div className="card">
                <div className="label">Net ↑ TX</div>
                <div className="value" style={{ fontSize: 22 }}>{fmtRate(snap.net.txRate)}</div>
                <div className="sub">total {fmtBytes(snap.net.txBytes)}</div>
                <Spark data={txHist} c="#a78bfa" />
              </div>
              <div className="card">
                <div className="label">Uptime</div>
                <div className="value" style={{ fontSize: 22 }}>{snap.system.uptimeFormatted}</div>
                <div className="sub">{snap.system.processCount} procs · load {snap.system.loadStatus} · 👤 {snap.system.username}</div>
                <Spark data={history.map((h) => (h.system.uptimeSec % 3600) / 36)} c="#8b93a7" />
              </div>
            </section>

            <section className="grid">
              <div>
                <div className="panel">
                  <h2>CPU &amp; Memory — last {HISTORY_N}s</h2>
                  <p className="hint mono">{snap.cpu.model} · {snap.cpu.speedMHz ? `${snap.cpu.speedMHz} MHz` : "speed n/a"}</p>
                  <TimeChart a={cpuHist} b={memHist} labelA="CPU" labelB="MEM" ca="#5794ff" cb="#3fce8f" />
                </div>
                <div className="panel">
                  <h2>Network throughput</h2>
                  <p className="hint">Per-second RX/TX deltas from cumulative interface counters (node-os-utils network + os.networkInterfaces).</p>
                  <TimeChart a={rxHist} b={txHist} labelA="RX" labelB="TX" ca="#4cc9f0" cb="#a78bfa" max={netMax} unit="B/s" />
                </div>
                <div className="panel">
                  <h2>Per-core CPU</h2>
                  <p className="hint">{snap.cpu.cores.length ? `${snap.cpu.cores.length} threads reported by node-os-utils` : "per-core detail unavailable on this host — showing aggregate"}</p>
                  <div className="cores">
                    {(snap.cpu.cores.length ? snap.cpu.cores : [snap.cpu.usage]).map((v, i) => (
                      <div className="core" key={i}>
                        <div className="row"><span>core {i}</span><span>{v.toFixed(1)}%</span></div>
                        <div className="bar"><div style={{ width: `${Math.min(100, v)}%`, background: color(v) }} /></div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <div>
                <div className="panel">
                  <h2>System</h2>
                  <div className="info-grid">
                    <div><div className="k">Hostname</div><div className="v mono">{snap.system.hostname}</div></div>
                    <div><div className="k">Platform</div><div className="v">{snap.system.platform}</div></div>
                    <div><div className="k">Arch / Release</div><div className="v mono">{snap.system.arch} · {snap.system.release}</div></div>
                    <div><div className="k">Distro / Type</div><div className="v">{snap.system.distro} · {snap.system.type}</div></div>
                    <div><div className="k">Swap</div><div className="v">{fmtBytes(snap.mem.swapUsedBytes)} / {fmtBytes(snap.mem.swapTotalBytes)} ({snap.mem.swapUsage.toFixed(1)}%)</div></div>
                    <div><div className="k">Updated</div><div className="v mono">{new Date(snap.timestamp).toLocaleTimeString()}</div></div>
                  </div>
                </div>

                <div className="panel">
                  <h2>Top processes by CPU</h2>
                  <p className="hint">node-os-utils process monitor · /proc fallback in containers · top {snap.processes.length}</p>
                  <table>
                    <thead><tr><th>PID</th><th>Name</th><th>CPU</th><th>MEM</th></tr></thead>
                    <tbody>
                      {snap.processes.map((p) => (
                        <tr key={p.pid}>
                          <td className="mono">{p.pid}</td>
                          <td className="mono">{p.name}</td>
                          <td style={{ color: color(p.cpu) }}>{p.cpu.toFixed(1)}%</td>
                          <td>{p.memMB.toFixed(1)} MB{p.memPct != null ? ` (${p.memPct.toFixed(1)}%)` : ""}</td>
                        </tr>
                      ))}
                      {snap.processes.length === 0 && <tr><td colSpan={4}>No process data on this host.</td></tr>}
                    </tbody>
                  </table>
                </div>

                <div className="panel">
                  <h2>Disks</h2>
                  <p className="hint">node-os-utils disk monitor · {fmtBytes(snap.disk.availableBytes)} available</p>
                  <table>
                    <thead><tr><th>Mount</th><th>FS</th><th>Used</th><th>Use%</th></tr></thead>
                    <tbody>
                      {snap.disk.mounts.map((m) => (
                        <tr key={m.mountpoint + m.filesystem}>
                          <td className="mono">{m.mountpoint}</td>
                          <td className="mono">{m.filesystem}</td>
                          <td>{fmtBytes(m.usedBytes)} / {fmtBytes(m.totalBytes)}</td>
                          <td>
                            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                              <div className="bar" style={{ flex: 1 }}><div style={{ width: `${Math.min(100, m.usage)}%`, background: color(m.usage) }} /></div>
                              <span>{m.usage.toFixed(0)}%</span>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="panel">
                  <h2>Network interfaces</h2>
                  <p className="hint">os.networkInterfaces + node-os-utils counters</p>
                  <table>
                    <thead><tr><th>Iface</th><th>State</th><th>RX / TX</th><th>Addr</th></tr></thead>
                    <tbody>
                      {snap.net.interfaces.map((n) => (
                        <tr key={n.name}>
                          <td className="mono">{n.name}</td>
                          <td><span className={`pill ${n.state === "up" ? "up" : "down"}`}>{n.state}</span></td>
                          <td className="mono">↓{fmtBytes(n.rxBytes)} ↑{fmtBytes(n.txBytes)}</td>
                          <td className="mono" style={{ fontSize: 11 }}>{n.addresses.join(", ") || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>
            <div className="footer">
              Realtime via WebSocket <span className="mono">/realtime</span> @1s · REST <span className="mono">/api/stats</span> ·
              built with Bun + <span className="mono">node-os-utils</span> + <span className="mono">node:os</span>
            </div>
          </>
        )}
      </main>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
