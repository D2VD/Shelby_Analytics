"use client";
/**
 * app/network/page.tsx — v3.1
 *
 * FIXES & PATCHES:
 * 1. Epoch NaN: EpochData interface now matches API response shape
 * {audit:{duration_ms, countdown:{remaining_ms, elapsed_ms, pct_complete, next_epoch_at_ms}}}
 * 2. Live UTC clock: ticks every second via setInterval, independent of data fetch
 * 3. Timeseries tab: +2 charts — Pending/Deleted + Avg Blob Size (matches Figure 3)
 * 4. Benchmark tab: +4 charts — Score/Upload/Latency/TXConfirm history (matches Figure 5)
 * 5. PATCH v3.1: Added NHICard to Overview tab and ActivityFeed to Explorer tab (Additive)
 * 6. PATCH v3.2: Replaced the in-page "Explorer" tab (link-out cards + ActivityFeed
 *    summary) with the Blob Expiry Monitor. The full Blob Explorer at /explorer is
 *    unaffected — this only removes the thin summary panel that used to live inside
 *    this Network page's tab bar. ActivityFeed import removed as it had no other
 *    consumer in this file.
 */

import { useEffect, useState, useRef, useCallback, Suspense } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import dynamic from "next/dynamic";
import { useNetwork } from "@/components/network-context";
import type { TsChartPoint } from "@/components/timeseries-chart";
import { ChangelogPanel } from "@/components/changelog-panel";

// TabTimeseries — eCharts, dynamically loaded (ssr:false) matching this
// project's existing convention for other browser-only visual libs (map
// component uses the same pattern for CF Pages compatibility).
const TimeseriesChart = dynamic(
  () => import("@/components/timeseries-chart").then((m) => m.TimeseriesChart),
  { ssr: false, loading: () => <div style={{ height: 130 }} /> }
);

// STEP 1 — Add imports from NETWORK PAGE PATCH
import { NHICard }      from "@/components/nhi-badge";

// A3 — SP distribution by AZ (UPGRADE_ROADMAP.md). Renamed from QuorumHealthByAZ
// in v2.0: the on-chain quorum constant (12) is per-placement-group, not
// per-AZ, so this no longer claims a quorum pass/fail verdict — see file header.
import { SpDistributionByAZ } from "@/components/quorum-health-az";

// Testnet retirement (Shelby announced shutdown Mon Aug 3, 2026, 12:00 PDT).
// Replaces the static "Live data from Aptos Testnet RPC" badge below, which
// becomes a false claim after shutdown — see component file header.
import { TestnetRetirementBanner } from "@/components/testnet-retirement-banner";
import { BlobExpiryMonitor } from "@/components/blob-expiry-monitor";

type TimeRange = "1h" | "24h" | "7d" | "30d";
type TabId = "overview" | "timeseries" | "epoch" | "benchmark" | "expiry" | "changelog";

// ─── Types ────────────────────────────────────────────────────────────────────
interface StatsLiveResponse {
  ts?: string; tsMs?: number; network?: string;
  totalBlobs?: number; totalStorageBytes?: number;
  totalStorageGB?: number; totalStorageGiB?: number;
  totalBlobEvents?: number;
  activeBlobs?: number; pendingOrFailed?: number; pendingBlobs?: number;
  deletedBlobs?: number; failedBlobs?: number; emptyRecords?: number;
  storageProviders?: number; waitlistedProviders?: number;
  frozenProviders?: number;
  placementGroups?: number; slices?: number;
  blockHeight?: number; ledgerVersion?: number; chainId?: number;
  method?: string; indexerStatus?: string;
}

interface TsPoint {
  tsMs:              number;
  activeBlobs:       number;
  totalStorageGB:    number;
  totalBlobEvents:   number;
  pendingOrFailed:   number;
  deletedBlobs:      number;
  blockHeight:       number;
  storageProviders?: number;
}

// FIX: EpochData now matches actual API response shape
interface EpochCountdownInfo {
  remaining_ms:    number;
  elapsed_ms:      number;
  pct_complete:    number;
  next_epoch_at_ms: number;
}

interface EpochCycleData {
  duration_ms: number;
  countdown:   EpochCountdownInfo;
  history:     Array<{ epoch: number; started_at: number; ended_at: number }>;
}

interface EpochData {
  current_audit_epoch:   number;
  current_payment_epoch: number;
  current_staking_epoch: number;
  audit:   EpochCycleData;
  payment: EpochCycleData;
  staking: EpochCycleData;
  config?: {
    min_sps_for_active_pg: number;
    max_placement_groups:  number;
    num_slots_per_pg:      number;
  } | null;
}

interface BenchRun {
  id: string; deviceId?: string; ip?: string; ts: string; tsMs?: number;
  score: number; tier: string; avgUploadKbs: number; avgDownloadKbs: number;
  latencyAvg: number; txConfirmMs: number; mode: string;
}

interface NHIData {
  nhi:    number;
  status: "healthy" | "degraded" | "critical";
  detail: string;
  components?: { spQuorum: number; nodeAvailability: number; epochHealth: number; storageUtilization: number; };
}

const POLL_MS    = 30_000;
const MAX_POINTS = 60;
const BENCH_PG   = 15;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function num(v: unknown, fb = 0): number { const n = Number(v ?? fb); return isFinite(n) ? n : fb; }
function str(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "string") return v || "—";
  if (typeof v === "number") return isFinite(v) ? String(v) : "—";
  return "—";
}
function fmt(n: number | null | undefined): string {
  if (n == null) return "—";
  return Math.round(n).toLocaleString("en-US");
}
function fmtBytes(b: number | null | undefined): string {
  if (b == null || b === 0) return "—";
  if (b >= 1e12) return `${(b/1e12).toFixed(2)} TB`;
  if (b >= 1e9)  return `${(b/1e9).toFixed(2)} GB`;
  if (b >= 1e6)  return `${(b/1e6).toFixed(1)} MB`;
  return `${b} B`;
}
function fmtMs(ms: number): string { return ms >= 1000 ? `${(ms/1000).toFixed(2)}s` : `${ms.toFixed(0)}ms`; }
function fmtKbs(k: number): string { return k >= 1024 ? `${(k/1024).toFixed(2)} MB/s` : `${k.toFixed(1)} KB/s`; }
function fmtDuration(ms: number): string {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
}

function isLiveSnap(d: unknown): d is StatsLiveResponse {
  if (!d || typeof d !== "object") return false;
  const r = d as Record<string, unknown>;
  return r.blockHeight != null || r.storageProviders != null || r.totalBlobs != null || r.activeBlobs != null;
}

// ─── Live UTC Clock (ticks every second) ──────────────────────────────────────
function LiveUTCClock() {
  const [clock, setClock] = useState("");
  useEffect(() => {
    const get = () => {
      const d = new Date();
      return `${String(d.getUTCHours()).padStart(2,"0")}:${String(d.getUTCMinutes()).padStart(2,"0")}:${String(d.getUTCSeconds()).padStart(2,"0")} UTC`;
    };
    setClock(get());
    const id = setInterval(() => setClock(get()), 1000);
    return () => clearInterval(id);
  }, []);
  if (!clock) return null;
  return (
    <span suppressHydrationWarning style={{ fontFamily: "monospace", fontSize: 12, color: "var(--text-dim)", padding: "4px 10px", borderRadius: 6, background: "var(--bg-card2)", border: "1px solid var(--border)" }}>
      🕐 {clock}
    </span>
  );
}

// ─── SparkLine ────────────────────────────────────────────────────────────────
function SparkLine({ data, color, height = 100 }: { data: number[]; color: string; height?: number }) {
  const valid = data.filter(v => v > 0);
  if (valid.length < 2) return (
    <div style={{ height, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 12 }}>Collecting data…</div>
  );
  const W = 560, PL = 44, PR = 8, PT = 8, PB = 8;
  const iW = W-PL-PR, iH = height-PT-PB;
  const mn = Math.min(...valid), mx = Math.max(...valid), rng = mx-mn||1;
  const xs = data.map((_,i) => PL+(i/(data.length-1))*iW);
  const ys = data.map(v => PT+iH-((v-mn)/rng)*iH);
  const ln = xs.map((x,i) => `${x.toFixed(1)},${ys[i].toFixed(1)}`).join(" ");
  const ar = `${PL},${PT+iH} ${ln} ${(PL+iW).toFixed(1)},${PT+iH}`;
  const gId = `g${color.replace(/[^a-z0-9]/gi,"")}`;
  const fmtV = (v: number) => v>=1e9?`${(v/1e9).toFixed(1)}G`:v>=1e6?`${(v/1e6).toFixed(1)}M`:v>=1e3?`${(v/1e3).toFixed(0)}K`:String(Math.round(v));
  return (
    <svg viewBox={`0 0 ${W} ${height}`} style={{ width:"100%", height, display:"block" }}>
      <defs><linearGradient id={gId} x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity={0.18}/><stop offset="100%" stopColor={color} stopOpacity={0.01}/></linearGradient></defs>
      {[0,0.5,1].map(f=>{const y=PT+iH-f*iH;return<g key={f}><line x1={PL} x2={W-PR} y1={y} y2={y} stroke="var(--border)"/><text x={PL-4} y={y+3} textAnchor="end" fontSize={9} fill="var(--text-dim)">{fmtV(mn+f*rng)}</text></g>;})}
      <polygon points={ar} fill={`url(#${gId})`}/>
      <polyline points={ln} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round"/>
      <circle cx={xs[xs.length-1]} cy={ys[ys.length-1]} r={4} fill={color} stroke="var(--bg-card)" strokeWidth={2}/>
    </svg>
  );
}

// ─── Quorum Health Bar ────────────────────────────────────────────────────────
function QuorumHealthBar({ nhi }: { nhi: NHIData | null }) {
  if (!nhi) return null;
  const color = nhi.status === "healthy" ? "#22c55e" : nhi.status === "degraded" ? "#f59e0b" : "#ef4444";
  const icon  = nhi.status === "healthy" ? "🟢" : nhi.status === "degraded" ? "🟡" : "🔴";
  const label = nhi.status === "healthy" ? "Network Healthy" : nhi.status === "degraded" ? "Degraded" : "Critical";
  return (
    <div style={{ background:`${color}10`, border:`1px solid ${color}44`, borderRadius:10, padding:"12px 18px", marginBottom:18, display:"flex", alignItems:"center", justifyContent:"space-between", flexWrap:"wrap", gap:10 }}>
      <div style={{ display:"flex", alignItems:"center", gap:10 }}>
        <span style={{ fontSize:16 }}>{icon}</span>
        <div>
          <div style={{ fontSize:13, fontWeight:700, color }}>{label}</div>
          <div style={{ fontSize:11, color:"var(--text-muted)" }}>{nhi.detail}</div>
        </div>
      </div>
      <div style={{ display:"flex", alignItems:"center", gap:10 }}>
        {nhi.components && (
          <div style={{ display:"flex", gap:12, fontSize:11, color:"var(--text-muted)" }}>
            {([["Quorum",nhi.components.spQuorum],["Node",nhi.components.nodeAvailability],["Epoch",nhi.components.epochHealth],["Storage",nhi.components.storageUtilization]] as [string,number][]).map(([l,v])=>(
              <span key={l}>{l} <strong style={{ color:v>=80?"#22c55e":v>=50?"#f59e0b":"#ef4444", fontFamily:"monospace" }}>{Math.round(v)}</strong></span>
            ))}
          </div>
        )}
        <div style={{ fontFamily:"monospace", fontSize:22, fontWeight:800, color, padding:"4px 12px", background:`${color}18`, borderRadius:8 }}>
          {Math.round(nhi.nhi)}<span style={{ fontSize:12, fontWeight:400, opacity:0.7 }}>/100</span>
        </div>
      </div>
    </div>
  );
}

// ─── StatCard ─────────────────────────────────────────────────────────────────
function StatCard({ label, value, sub, icon, color, loading }: { label:string; value:string; sub?:string; icon:string; color:string; loading:boolean }) {
  return (
    <div style={{ background:"var(--bg-card)", border:"1px solid var(--border)", borderRadius:14, padding:"18px 20px", borderTop:`3px solid ${color}`, transition:"background 0.2s" }}>
      <div style={{ display:"flex", justifyContent:"space-between", marginBottom:8 }}>
        <span style={{ fontSize:11, color:"var(--text-muted)", textTransform:"uppercase", letterSpacing:"0.08em", fontWeight:600 }}>{str(label)}</span>
        <span style={{ fontSize:15, opacity:0.4 }}>{icon}</span>
      </div>
      <div style={{ fontSize:27, fontWeight:800, color:loading?"var(--text-dim)":"var(--text-primary)", letterSpacing:-0.8, lineHeight:1.1, fontFamily:"monospace", fontVariantNumeric:"tabular-nums" }}>
        {loading ? "…" : value}
      </div>
      {sub != null && sub !== "" && <div style={{ fontSize:12, color:"var(--text-muted)", marginTop:5 }}>{str(sub)}</div>}
    </div>
  );
}

// ─── BlobBreakdown ────────────────────────────────────────────────────────────
function BlobBreakdown({ snap }: { snap: StatsLiveResponse }) {
  const items = [
    { label:"Active",  v:snap.activeBlobs,    color:"#22c55e", hint:"is_written=1, is_deleted=0" },
    { label:"Pending", v:snap.pendingOrFailed, color:"#f59e0b", hint:"is_written=0" },
    { label:"Deleted", v:snap.deletedBlobs,    color:"#ef4444", hint:"is_deleted=1" },
    { label:"Empty",   v:snap.emptyRecords,    color:"#9ca3af", hint:"size=0" },
  ];
  const total = items.reduce((s,i) => s + num(i.v), 0);
  return (
    <div style={{ background:"var(--bg-card)", border:"1px solid var(--border)", borderRadius:14, padding:"18px 22px" }}>
      <div style={{ fontSize:11, fontWeight:600, textTransform:"uppercase", letterSpacing:"0.08em", color:"var(--text-muted)", marginBottom:12 }}>Blob Breakdown</div>
      <div style={{ display:"flex", height:6, borderRadius:3, overflow:"hidden", marginBottom:12, gap:1 }}>
        {items.map(({label,v,color})=>{const pct=total>0?num(v)/total*100:0;return<div key={label} style={{width:`${pct}%`,background:color,transition:"width 0.5s"}} title={`${label}: ${fmt(num(v))}`}/>;} )}
      </div>
      {items.map(({label,v,color,hint})=>(
        <div key={label} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6 }}>
          <div style={{ display:"flex", alignItems:"center", gap:7 }}>
            <div style={{ width:8, height:8, borderRadius:2, background:color, flexShrink:0 }}/>
            <span style={{ fontSize:13, color:"var(--text-muted)" }} title={hint}>{label}</span>
          </div>
          <span style={{ fontSize:14, fontWeight:700, color:"var(--text-primary)", fontFamily:"monospace" }}>{fmt(num(v))}</span>
        </div>
      ))}
      <div style={{ marginTop:8, paddingTop:6, borderTop:"1px solid var(--border-soft)", display:"flex", justifyContent:"space-between" }}>
        <span style={{ fontSize:11, color:"var(--text-dim)" }}>Total (is_written=1)</span>
        <span style={{ fontSize:13, fontWeight:800, color:"var(--accent)", fontFamily:"monospace" }}>{fmt(snap.totalBlobs)}</span>
      </div>
    </div>
  );
}

// ─── RangeSel ─────────────────────────────────────────────────────────────────
function RangeSel({ range, onChange }: { range: TimeRange; onChange: (r: TimeRange) => void }) {
  return (
    <div style={{ display:"flex", gap:3, background:"var(--bg-card2)", border:"1px solid var(--border)", borderRadius:8, padding:3 }}>
      {(["1h","24h","7d","30d"] as TimeRange[]).map(r=>(
        <button key={r} onClick={()=>onChange(r)} style={{ padding:"5px 13px", borderRadius:6, fontSize:12, fontWeight:r===range?700:400, border:"none", cursor:"pointer", background:r===range?"var(--accent)":"transparent", color:r===range?"#fff":"var(--text-muted)", transition:"all 0.1s" }}>{r}</button>
      ))}
    </div>
  );
}

// ─── Epoch Countdown — FIXED to use API response shape ───────────────────────
function EpochCountdown({ epoch }: { epoch: EpochData }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const cycles = [
    { label:"Audit Epoch",   data:epoch.audit,   current:epoch.current_audit_epoch,   color:"#0891b2", icon:"🔍" },
    { label:"Payment Epoch", data:epoch.payment, current:epoch.current_payment_epoch, color:"#16a34a", icon:"💰" },
    { label:"Staking Epoch", data:epoch.staking, current:epoch.current_staking_epoch, color:"#9333ea", icon:"🔒" },
  ];

  return (
    <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(220px, 1fr))", gap:14 }}>
      {cycles.map(({ label, data, current, color, icon }) => {
        // Compute live remaining from next_epoch_at_ms − now
        const nowMs = Date.now();
        const remaining_ms = Math.max(0, data.countdown.next_epoch_at_ms - nowMs);
        const elapsed_ms   = data.duration_ms > 0 ? Math.max(0, data.duration_ms - remaining_ms) : data.countdown.elapsed_ms;
        const pct = data.duration_ms > 0 ? Math.min(100, (elapsed_ms / data.duration_ms) * 100) : data.countdown.pct_complete;
        const countdownStr = fmtDuration(remaining_ms);

        return (
          <div key={label} style={{ background:"var(--bg-card)", border:"1px solid var(--border)", borderRadius:14, padding:"18px 20px" }}>
            <div style={{ display:"flex", justifyContent:"space-between", marginBottom:10 }}>
              <div>
                <div style={{ fontSize:12, fontWeight:700, color:"var(--text-muted)", textTransform:"uppercase", letterSpacing:"0.07em" }}>{icon} {label}</div>
                <div style={{ fontSize:11, color:"var(--text-dim)", marginTop:2 }}>Epoch #{current}</div>
              </div>
              <div style={{ fontFamily:"monospace", fontSize:18, fontWeight:800, color, lineHeight:1 }}>
                {countdownStr}
              </div>
            </div>
            <div style={{ height:5, background:"var(--border)", borderRadius:3, overflow:"hidden" }}>
              <div style={{ height:"100%", width:`${pct}%`, background:color, borderRadius:3, transition:"width 1s linear" }}/>
            </div>
            <div style={{ display:"flex", justifyContent:"space-between", marginTop:5, fontSize:10, color:"var(--text-dim)" }}>
              <span>{pct.toFixed(1)}% elapsed</span>
              <span>{remaining_ms > 0 ? "remaining" : "ending…"}</span>
            </div>
            {/* History */}
            {data.history && data.history.length > 0 && (
              <div style={{ marginTop:12, paddingTop:10, borderTop:"1px solid var(--border-soft)" }}>
                <div style={{ fontSize:9, fontWeight:700, textTransform:"uppercase", letterSpacing:"0.08em", color:"var(--text-dim)", marginBottom:6 }}>Recent epochs</div>
                {data.history.slice(0,3).map((h,i) => (
                  <div key={h.epoch} style={{ display:"flex", alignItems:"center", gap:5, marginBottom:3 }}>
                    <span style={{ fontSize:9, fontFamily:"monospace", color:i===0?color:"var(--text-dim)" }}>#{h.epoch}</span>
                    <span style={{ fontSize:9, color:"var(--text-dim)", fontFamily:"monospace" }}>
                      {new Date(h.started_at).toLocaleString([], { month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit" })}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Overview Tab ─────────────────────────────────────────────────────────────
function OverviewTab({ network, snap, series, loading, nhi, isTestnet, accentColor }: {
  network: string; snap: StatsLiveResponse | null; series: TsPoint[]; loading: boolean;
  nhi: NHIData | null; isTestnet: boolean; accentColor: string;
}) {
  const METRICS = isTestnet ? [
    { label:"Active Blobs",      value:fmt(snap?.activeBlobs),         sub:"From Indexer",                icon:"◈", color:"#0891b2" },
    { label:"Block Height",      value:snap?.blockHeight?`#${snap.blockHeight.toLocaleString("en-US")}`:"—", sub:`Ledger v${fmt(snap?.ledgerVersion)}`, icon:"⬡", color:"#9333ea" },
    { label:"Storage Providers", value:fmt(snap?.storageProviders),    sub:`+${snap?.waitlistedProviders??0} waitlisted`, icon:"◎", color:"#0891b2" },
    { label:"Placement Groups",  value:fmt(snap?.placementGroups),     sub:"Epoch registry",              icon:"▦", color:"#d97706" },
    { label:"Slices",            value:fmt(snap?.slices),               sub:"Slice registry",              icon:"⬡", color:"#7c3aed" },
    { label:"Total Blobs",       value:fmt(snap?.totalBlobs),           sub:"is_written=1",                icon:"◈", color:"#9333ea" },
  ] : [
    { label:"Total Blobs",       value:fmt(snap?.totalBlobs),           sub:"is_written=1 (matches Explorer)", icon:"◈", color:"#2563eb" },
    { label:"Storage Used",      value:fmtBytes(snap?.totalStorageBytes), sub:snap?.totalStorageGiB?`${Number(snap.totalStorageGiB).toFixed(2)} GiB`:"", icon:"▣", color:"#059669" },
    { label:"Active Blobs",      value:fmt(snap?.activeBlobs),         sub:"is_written=1, is_deleted=0",  icon:"◎", color:"#22c55e" },
    { label:"Storage Providers", value:fmt(snap?.storageProviders),    sub:"Active SPs on-chain",         icon:"◎", color:"#0891b2" },
    { label:"Placement Groups",  value:fmt(snap?.placementGroups),     sub:"Erasure code groups",         icon:"▦", color:"#d97706" },
    { label:"Slices",            value:fmt(snap?.slices),               sub:"Slice registry count",        icon:"⬡", color:"#7c3aed" },
  ];

  const CHARTS = [
    { title:"Total Blobs",  sub:"is_written=1", latest:fmt(snap?.totalBlobs), data:series.map(p=>p.activeBlobs).filter(v=>v>0), color:accentColor },
    { title:"Block Height", sub:"Chain",        latest:snap?.blockHeight?`#${snap.blockHeight.toLocaleString("en-US")}`:"—", data:series.map(p=>p.blockHeight).filter(v=>v>0), color:"#059669" },
    ...(!isTestnet ? [
      { title:"Storage Used", sub:"Indexer bytes", latest:fmtBytes(snap?.totalStorageBytes), data:series.map(p=>num(p.totalStorageGB)*1e9).filter(v=>v>0), color:"#9333ea" },
      { title:"Blob Events",  sub:"blob_activities", latest:fmt(snap?.totalBlobEvents), data:series.map(p=>p.totalBlobEvents).filter(v=>v>0), color:"#d97706" },
    ] : [
      { title:"Storage Providers", sub:"Active", latest:fmt(snap?.storageProviders), data:series.map(p=>num(p.storageProviders)).filter(v=>v>0), color:"#0891b2" },
      { title:"Placement Groups",  sub:"Epoch",  latest:fmt(snap?.placementGroups), data:[], color:"#d97706" },
    ]),
  ] as Array<{title:string;sub:string;latest:string;data:number[];color:string}>;

  return (
    <div>
      {/* STEP 2 — NHICard in the Overview tab (Additive) */}
      <div style={{ marginBottom: 24 }}>
        <NHICard network={network} />
      </div>

      <QuorumHealthBar nhi={nhi} />
      <SpDistributionByAZ network={network} />
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, marginBottom:18 }}>
        <div style={{ background:"var(--bg-card)", border:"1px solid var(--border)", borderRadius:14, padding:"18px 22px" }}>
          <div style={{ fontSize:11, fontWeight:600, textTransform:"uppercase", letterSpacing:"0.08em", color:"var(--text-muted)", marginBottom:8 }}>Block Height</div>
          <div style={{ fontFamily:"monospace", fontSize:30, fontWeight:800, color:accentColor, fontVariantNumeric:"tabular-nums", wordBreak:"break-all" }}>
            {snap?.blockHeight ? `#${snap.blockHeight.toLocaleString("en-US")}` : loading ? "…" : "—"}
          </div>
          <div style={{ fontSize:12, color:"var(--text-muted)", marginTop:5 }}>
            Ledger v{snap?.ledgerVersion ? snap.ledgerVersion.toLocaleString("en-US") : "—"}
            {isTestnet && snap?.chainId != null && <span style={{ marginLeft:10, color:"var(--text-dim)" }}>Chain {snap.chainId}</span>}
          </div>
        </div>
        {snap ? <BlobBreakdown snap={snap} /> : (
          <div style={{ background:"var(--bg-card)", border:"1px solid var(--border)", borderRadius:14, padding:"18px 22px", display:"flex", alignItems:"center", justifyContent:"center", color:"var(--text-dim)", fontSize:14 }}>
            {loading ? "Loading…" : "No data"}
          </div>
        )}
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(3, 1fr)", gap:12, marginBottom:22 }}>
        {METRICS.map(m => <StatCard key={m.label} loading={loading && !snap} {...m} />)}
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14 }}>
        {CHARTS.map(c => (
          <div key={c.title} style={{ background:"var(--bg-card)", border:"1px solid var(--border)", borderRadius:14, padding:"16px 20px" }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:12, flexWrap:"wrap", gap:6 }}>
              <div>
                <div style={{ fontSize:13, fontWeight:700, color:"var(--text-primary)" }}>{c.title}</div>
                <div style={{ fontSize:11, color:"var(--text-muted)" }}>{c.sub}</div>
              </div>
              <div style={{ fontFamily:"monospace", fontSize:16, fontWeight:700, color:c.color }}>{c.latest}</div>
            </div>
            <SparkLine data={c.data} color={c.color} height={110} />
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Timeseries Tab — FIXED: +2 charts (Pending/Deleted + Avg Blob Size) ─────
function TimeseriesTab({ network, isTestnet, accentColor }: { network:string; isTestnet:boolean; accentColor:string }) {
  const [range, setRange] = useState<TimeRange>("24h");
  const [ts,    setTs]    = useState<TsPoint[]>([]);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  useEffect(() => {
    const res = range==="1h"||range==="24h" ? "5m" : "1h";
    fetch(`/api/network/stats/timeseries?network=${network}&resolution=${res}&range=${range}`)
      .then(r => r.json() as Promise<Record<string,unknown>>)
      .then(j => {
        const arr = ((j?.data as Record<string,unknown>)?.series ?? []) as Record<string,unknown>[];
        if (alive.current) setTs(arr.map(s => ({
          tsMs:             num(s.tsMs),
          activeBlobs:      num(s.activeBlobs),
          totalStorageGB:   num(s.totalStorageGB),
          totalBlobEvents:  num(s.totalBlobEvents),
          pendingOrFailed:  num(s.pendingOrFailed),
          deletedBlobs:     num(s.deletedBlobs),
          blockHeight:      num(s.blockHeight),
          storageProviders: num(s.storageProviders),
        })));
      }).catch(()=>{});
  }, [network, range]);

  const cd = ts;
  const last = cd[cd.length-1];

  // Maps a numeric field off each TsPoint into {tsMs, value} pairs for TimeseriesChart.
  // Zero values are now plotted (not dropped) — see behavior-change note in
  // components/timeseries-chart.tsx's header comment.
  const toPoints = (pick: (p: TsPoint) => number): TsChartPoint[] =>
    cd.map(p => ({ tsMs: p.tsMs, value: pick(p) }));

  // Compute avg blob size for each point: (storageGB * 1e9) / activeBlobs in KB
  const avgKB = (p: TsPoint) => (p.activeBlobs > 0 && p.totalStorageGB > 0) ? (p.totalStorageGB * 1e9) / p.activeBlobs / 1024 : 0;
  const avgBlobSizePoints = toPoints(avgKB);
  const lastAvgKB = last ? avgKB(last) : 0;

  const ChartCard = ({ title, sub, latest, latestColor, points, color, h = 130, range }: {
  title: string; sub: string; latest: string; latestColor: string; points: TsChartPoint[]; color: string; h?: number; range?: TimeRange;
}) => (
  <div style={{ background:"var(--bg-card)", border:"1px solid var(--border)", borderRadius:14, padding:"16px 20px" }}>
    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:12 }}>
      <div>
        <div style={{ fontSize:13, fontWeight:700, color:"var(--text-primary)" }}>{title}</div>
        <div style={{ fontSize:11, color:"var(--text-muted)" }}>{sub}</div>
      </div>
      <div style={{ fontFamily:"monospace", fontSize:15, fontWeight:700, color:latestColor }}>{latest}</div>
    </div>
    <TimeseriesChart points={points} color={color} height={h} range={range} />
  </div>
);

  return (
    <div>
      {/* Header */}
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:18, flexWrap:"wrap", gap:10 }}>
        <p style={{ fontSize:13, color:"var(--text-muted)", margin:0 }}>{cd.length} data points · {isTestnet?"Aptos Testnet RPC":"Shelby Dedicated Indexer"}</p>
        <RangeSel range={range} onChange={setRange} />
      </div>

      {/* Section: Blob Analytics */}
      <div style={{ fontSize:12, fontWeight:700, textTransform:"uppercase", letterSpacing:"0.08em", color:"var(--text-muted)", marginBottom:12 }}>Blob Analytics</div>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14, marginBottom:14 }}>
        <ChartCard title="Active Blobs" sub={`${range} window`} latest={fmt(last?.activeBlobs)} latestColor="#22c55e" points={toPoints(p=>p.activeBlobs)} color="#22c55e" range={range} />
        <ChartCard title="Blob Events" sub="blob_activities count" latest={fmt(last?.totalBlobEvents)} latestColor="#f59e0b" points={toPoints(p=>p.totalBlobEvents)} color="#f59e0b" range={range} />
      </div>
      {/* Pending + Deleted — full width */}
      <div style={{ background:"var(--bg-card)", border:"1px solid var(--border)", borderRadius:14, padding:"16px 20px", marginBottom:20 }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:8, flexWrap:"wrap", gap:8 }}>
          <div>
            <div style={{ fontSize:13, fontWeight:700, color:"var(--text-primary)" }}>Pending &amp; Deleted Blobs</div>
            <div style={{ fontSize:11, color:"var(--text-muted)" }}>Anomaly tracking · auto-scaled per series</div>
          </div>
          <div style={{ display:"flex", gap:16 }}>
            <span style={{ fontFamily:"monospace", fontSize:13, fontWeight:700, color:"#f59e0b" }}>P: {fmt(last?.pendingOrFailed)}</span>
            <span style={{ fontFamily:"monospace", fontSize:13, fontWeight:700, color:"#ef4444" }}>D: {fmt(last?.deletedBlobs)}</span>
          </div>
        </div>
        {/* Two mini sparklines side by side */}
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
          <div>
            <div style={{ fontSize:10, color:"var(--text-dim)", marginBottom:4 }}>Pending</div>
            <TimeseriesChart points={toPoints(p=>p.pendingOrFailed)} color="#f59e0b" height={80} range={range} />
          </div>
          <div>
            <div style={{ fontSize:10, color:"var(--text-dim)", marginBottom:4 }}>Deleted</div>
            <TimeseriesChart points={toPoints(p=>p.deletedBlobs)} color="#ef4444" height={80} range={range} />
          </div>
        </div>
      </div>

      {/* Section: Storage Analytics */}
      <div style={{ fontSize:12, fontWeight:700, textTransform:"uppercase", letterSpacing:"0.08em", color:"var(--text-muted)", marginBottom:12 }}>Storage Analytics</div>
      <div style={{ display:"grid", gridTemplateColumns:"2fr 1fr", gap:14, marginBottom:14 }}>
        <ChartCard title="Storage Used (GB)" sub="Active blobs only" latest={`${(last?.totalStorageGB??0).toFixed(2)} GB`} latestColor="#9333ea" points={toPoints(p=>p.totalStorageGB)} color="#9333ea" range={range} />
        <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
          {[
            { label:"Total Storage",  val:`${(last?.totalStorageGB??0).toFixed(2)} GB`, color:"#9333ea" },
            { label:"Active Blobs",   val:fmt(last?.activeBlobs),                        color:"#22c55e" },
            { label:"Avg Blob Size",  val:lastAvgKB>0?(lastAvgKB>=1024?`${(lastAvgKB/1024).toFixed(1)} MB`:`${lastAvgKB.toFixed(0)} KB`):"—", color:accentColor },
          ].map(({ label, val, color }) => (
            <div key={label} style={{ flex:1, background:"var(--bg-card)", border:"1px solid var(--border)", borderRadius:12, padding:"12px 16px" }}>
              <div style={{ fontSize:10, fontWeight:600, textTransform:"uppercase", letterSpacing:"0.07em", color:"var(--text-muted)", marginBottom:4 }}>{label}</div>
              <div style={{ fontSize:16, fontWeight:800, color, fontFamily:"monospace" }}>{val}</div>
            </div>
          ))}
        </div>
      </div>
      {/* Avg Blob Size chart */}
      <div style={{ background:"var(--bg-card)", border:"1px solid var(--border)", borderRadius:14, padding:"16px 20px", marginBottom:20 }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:12 }}>
          <div>
            <div style={{ fontSize:13, fontWeight:700, color:"var(--text-primary)" }}>Avg Blob Size over Time</div>
            <div style={{ fontSize:11, color:"var(--text-muted)" }}>totalStorageBytes / activeBlobs</div>
          </div>
          <div style={{ fontFamily:"monospace", fontSize:15, fontWeight:700, color:accentColor }}>
            {lastAvgKB>0?(lastAvgKB>=1024?`${(lastAvgKB/1024).toFixed(1)} MB`:`${lastAvgKB.toFixed(0)} KB`):"—"}
          </div>
        </div>
        <TimeseriesChart points={avgBlobSizePoints} color={accentColor} height={110} range={range} />
      </div>

      {/* Block Height */}
      <div style={{ fontSize:12, fontWeight:700, textTransform:"uppercase", letterSpacing:"0.08em", color:"var(--text-muted)", marginBottom:12 }}>Block Performance</div>
      <ChartCard
        title="Block Height" sub="Chain progress"
        latest={last?.blockHeight ? `#${last.blockHeight.toLocaleString("en-US")}` : "—"}
        latestColor={accentColor}
        points={toPoints(p=>p.blockHeight)} color={accentColor}
        range={range}
      />
    </div>
  );
}
// ─── Epoch Tab — FIXED: uses new EpochData shape ─────────────────────────────
function EpochTab({ network }: { network: string }) {
  const [epoch, setEpoch] = useState<EpochData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  // FIX: was a single fetch-on-mount with no re-fetch — once an epoch actually
  // rolled over on-chain, next_epoch_at_ms stayed stuck at its expired value
  // forever (EpochCountdown's local Date.now() ticker just kept recomputing
  // max(0, expired - now), which is permanently 0). Only a page reload (=
  // remount = one fresh fetch) ever cleared it. Now polls every 20s so the
  // countdown re-syncs to the new epoch automatically after rollover.
  const fetchEpoch = useCallback(async (isInitial: boolean) => {
    if (isInitial && alive.current) { setEpoch(null); setError(null); setLoading(true); }
    try {
      const r = await fetch(`/api/network/epoch?network=${network}`, { signal: AbortSignal.timeout(10_000) });
      const j = await r.json() as Record<string, unknown>;
      if (!alive.current) return;
      if (j.ok && j.data) {
        setEpoch(j.data as EpochData);
        setError(null);
      } else if (isInitial) {
        setError(String(j.error ?? "Epoch data unavailable"));
      }
      // Non-initial (background poll) failures deliberately don't clear a
      // previously-loaded epoch or show an error — the countdown keeps
      // ticking fine off the last good data until the next successful poll.
    } catch (e) {
      if (alive.current && isInitial) setError((e as Error).message);
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [network]);

  useEffect(() => {
    fetchEpoch(true);
    const id = setInterval(() => fetchEpoch(false), 20_000);
    return () => clearInterval(id);
  }, [fetchEpoch]);

  if (loading) return <div style={{ padding:32, textAlign:"center", color:"var(--text-muted)", fontSize:13 }}>Loading epoch data…</div>;
  if (error)   return <div style={{ padding:32, textAlign:"center", color:"#ef4444", fontSize:13 }}>⚠ {error}</div>;
  if (!epoch)  return <div style={{ padding:32, textAlign:"center", color:"var(--text-muted)", fontSize:13 }}>No epoch data available</div>;

  return (
    <div>
      <p style={{ fontSize:13, color:"var(--text-muted)", marginBottom:18 }}>Epoch cycles for audit, payment, and staking operations on-chain.</p>
      <EpochCountdown epoch={epoch} />
      {epoch.config && (
        <div style={{ marginTop:14, display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:10 }}>
          {[
            { label:"Min SPs for Active PG", value: epoch.config.min_sps_for_active_pg },
            { label:"Max Placement Groups",  value: epoch.config.max_placement_groups },
            { label:"Slots per PG",          value: epoch.config.num_slots_per_pg },
          ].map(({ label, value }) => (
            <div key={label} style={{ background:"var(--bg-card2)", border:"1px solid var(--border)", borderRadius:10, padding:"10px 14px", textAlign:"center" }}>
              <div style={{ fontSize:10, color:"var(--text-dim)", textTransform:"uppercase", letterSpacing:"0.07em", marginBottom:3 }}>{label}</div>
              <div style={{
                fontSize: value == null ? 12 : 18,
                fontWeight: value == null ? 500 : 700,
                fontFamily: value == null ? "inherit" : "monospace",
                fontStyle: value == null ? "italic" : "normal",
                color: value == null ? "var(--text-dim)" : "var(--text-primary)",
              }}>
                {value == null ? "Not publicly available" : String(value)}
              </div>
            </div>
          ))}
        </div>
      )}
      <div style={{ marginTop:14, background:"var(--bg-card2)", border:"1px solid var(--border)", borderRadius:10, padding:"12px 16px", fontSize:11, color:"var(--text-dim)", fontFamily:"monospace" }}>
        Contract: 0x85fdb9a1… · Epoch data from Shelby::epoch::Epoch resource
      </div>
    </div>
  );
}

// ─── Benchmark Tab — FIXED: +4 charts (Score/Upload/Latency/TX) ───────────────
function BenchmarkTab() {
  const [bench,   setBench]   = useState<BenchRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [page,    setPage]    = useState(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  useEffect(() => {
    fetch("/api/benchmark/results?limit=200")
      .then(r => r.json() as Promise<Record<string,unknown>>)
      .then(j => { if (alive.current) setBench(Array.isArray(j?.results) ? (j.results as BenchRun[]) : []); })
      .catch(()=>{})
      .finally(()=>{ if (alive.current) setLoading(false); });
  }, []);

  if (loading) return <div style={{ padding:32, textAlign:"center", color:"var(--text-muted)" }}>Loading benchmark results…</div>;
  if (!bench.length) return <div style={{ padding:32, textAlign:"center", color:"var(--text-muted)" }}>No benchmark runs yet.</div>;

  const paged  = bench.slice(page * BENCH_PG, (page + 1) * BENCH_PG);
  const pages  = Math.ceil(bench.length / BENCH_PG);
  const chronological = [...bench].reverse();

  const avgScore   = bench.reduce((s,h)=>s+num(h.score),0)/bench.length;
  const avgUp      = bench.reduce((s,h)=>s+num(h.avgUploadKbs),0)/bench.length;
  const avgLatency = bench.reduce((s,h)=>s+num(h.latencyAvg),0)/bench.length;
  const avgTx      = bench.reduce((s,h)=>s+num(h.txConfirmMs),0)/bench.length;
  const topScore   = Math.max(...bench.map(h=>h.score));

  const bLabels = chronological.map(h => h.ts ? new Date(h.ts).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}) : "");

  const MiniChart = ({ data, color, h = 110 }: { data:number[]; color:string; h?:number }) => (
    <SparkLine data={data} color={color} height={h} />
  );

  return (
    <div>
      {/* Stats row */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:12, marginBottom:18 }}>
        {[
          { label:"Total Runs",  value:String(bench.length),     color:"var(--accent)" },
          { label:"Avg Score",   value:String(Math.round(avgScore)), color:"#818cf8" },
          { label:"Avg Upload",  value:fmtKbs(avgUp),             color:"var(--accent)" },
          { label:"Top Score",   value:String(topScore),          color:"#22c55e" },
        ].map(({ label, value, color }) => (
          <div key={label} style={{ background:"var(--bg-card)", border:"1px solid var(--border)", borderRadius:10, padding:"12px 16px", textAlign:"center" }}>
            <div style={{ fontSize:11, color:"var(--text-muted)", textTransform:"uppercase", letterSpacing:"0.07em", marginBottom:4 }}>{label}</div>
            <div style={{ fontSize:20, fontWeight:800, color, fontFamily:"monospace" }}>{value}</div>
          </div>
        ))}
      </div>

      {/* 4 Charts */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14, marginBottom:18 }}>
        {[
          { title:"Score History",    sub:"All users · all time",               data:chronological.map(h=>num(h.score)),         color:"#818cf8", latest:String(bench[0]?.score??"") },
          { title:"Avg Upload Speed", sub:"Upload performance over time",        data:chronological.map(h=>num(h.avgUploadKbs)),  color:"#2563eb", latest:fmtKbs(avgUp) },
          { title:"Avg Latency",      sub:"Node ping",                           data:chronological.map(h=>num(h.latencyAvg)),    color:"#c084fc", latest:fmtMs(avgLatency) },
          { title:"TX Confirm Time",  sub:"Aptos transaction confirmation",      data:chronological.map(h=>num(h.txConfirmMs)),   color:"#fb923c", latest:fmtMs(avgTx) },
        ].map(c => (
          <div key={c.title} style={{ background:"var(--bg-card)", border:"1px solid var(--border)", borderRadius:14, padding:"16px 20px" }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:12 }}>
              <div>
                <div style={{ fontSize:13, fontWeight:700, color:"var(--text-primary)" }}>{c.title}</div>
                <div style={{ fontSize:11, color:"var(--text-muted)" }}>{c.sub}</div>
              </div>
              <div style={{ fontFamily:"monospace", fontSize:15, fontWeight:700, color:c.color }}>{c.latest}</div>
            </div>
            <MiniChart data={c.data} color={c.color} />
            {bLabels.length > 1 && (
              <div style={{ display:"flex", justifyContent:"space-between", fontSize:9, color:"var(--text-dim)", fontFamily:"monospace", marginTop:4 }}>
                <span>{bLabels[0]}</span><span>{bLabels[bLabels.length-1]}</span>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Table */}
      <div style={{ background:"var(--bg-card)", border:"1px solid var(--border)", borderRadius:12, overflow:"hidden" }}>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"12px 16px", borderBottom:"1px solid var(--border)" }}>
          <div style={{ fontSize:14, fontWeight:700, color:"var(--text-primary)" }}>Global Run History</div>
          <div style={{ fontSize:12, color:"var(--text-muted)" }}>{bench.length} runs · Page {page+1}/{Math.max(1,pages)}</div>
        </div>
        <div style={{ overflowX:"auto" }}>
          <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13 }}>
            <thead><tr style={{ background:"var(--bg-card2)", borderBottom:"1px solid var(--border)" }}>
              {["Device","Time","Score","Tier","Upload","Latency","TX","Mode"].map(h=>(
                <th key={h} style={{ padding:"9px 13px", textAlign:"left", fontSize:10, fontWeight:600, color:"var(--text-dim)", textTransform:"uppercase", letterSpacing:"0.07em", whiteSpace:"nowrap", borderBottom:"1px solid var(--border)" }}>{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {paged.map((h, i) => {
                const sc = num(h.score);
                const c  = sc>=900?"#22c55e":sc>=600?"#fbbf24":"#f87171";
                return (
                  <tr key={h.id||String(i)} style={{ borderTop:"1px solid var(--border-soft)" }}>
                    <td style={{ padding:"8px 13px", fontFamily:"monospace", fontSize:11, color:"var(--text-muted)" }}>{h.deviceId??h.ip??"—"}</td>
                    <td style={{ padding:"8px 13px", fontSize:11, color:"var(--text-dim)", fontFamily:"monospace", whiteSpace:"nowrap" }}>
                      {h.ts?new Date(h.ts).toLocaleString([],{month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"}):"—"}
                    </td>
                    <td style={{ padding:"8px 13px" }}><span style={{ fontFamily:"monospace", fontWeight:800, color:c, fontSize:14 }}>{sc||"—"}</span></td>
                    <td style={{ padding:"8px 13px" }}><span style={{ fontSize:11, color:c, fontWeight:600 }}>{h.tier}</span></td>
                    <td style={{ padding:"8px 13px", fontFamily:"monospace", color:"var(--accent)", whiteSpace:"nowrap" }}>{fmtKbs(h.avgUploadKbs)}</td>
                    <td style={{ padding:"8px 13px", fontFamily:"monospace", color:"#c084fc", whiteSpace:"nowrap" }}>{fmtMs(h.latencyAvg)}</td>
                    <td style={{ padding:"8px 13px", fontFamily:"monospace", color:"#fb923c", whiteSpace:"nowrap" }}>{fmtMs(h.txConfirmMs)}</td>
                    <td style={{ padding:"8px 13px" }}><span style={{ fontSize:10, fontWeight:700, color:"#818cf8", textTransform:"uppercase" }}>{h.mode}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {pages > 1 && (
          <div style={{ padding:"10px 16px", borderTop:"1px solid var(--border-soft)", display:"flex", justifyContent:"center", gap:5 }}>
            <button onClick={()=>setPage(p=>Math.max(0,p-1))} disabled={page===0} style={{ padding:"4px 11px", borderRadius:6, border:"1px solid var(--border)", background:"var(--bg-card)", color:"var(--text-muted)", cursor:page===0?"not-allowed":"pointer", opacity:page===0?0.4:1, fontSize:12 }}>←</button>
            <span style={{ padding:"4px 10px", fontSize:12, color:"var(--text-muted)" }}>{page+1}/{pages}</span>
            <button onClick={()=>setPage(p=>Math.min(pages-1,p+1))} disabled={page===pages-1} style={{ padding:"4px 11px", borderRadius:6, border:"1px solid var(--border)", background:"var(--bg-card)", color:"var(--text-muted)", cursor:page===pages-1?"not-allowed":"pointer", opacity:page===pages-1?0.4:1, fontSize:12 }}>→</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Tab Reader ───────────────────────────────────────────────────────────────
function TabReader({ onTab }: { onTab: (t: TabId) => void }) {
  const searchParams = useSearchParams();
  useEffect(() => {
    const t = searchParams?.get("tab") as TabId | null;
    if (t && ["overview","timeseries","epoch","benchmark","expiry","changelog"].includes(t)) onTab(t);
  }, [searchParams, onTab]);
  return null;
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function NetworkPage() {
  const { network } = useNetwork();
  const router      = useRouter();
  const pathname    = usePathname();
  const isTestnet   = network === "testnet";
  const accentColor = isTestnet ? "#9333ea" : "#2563eb";
  const alive       = useRef(true);

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const [tab,     setTab]     = useState<TabId>("overview");
  const [snap,    setSnap]    = useState<StatsLiveResponse | null>(null);
  const [series,  setSeries]  = useState<TsPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [nhi,     setNhi]     = useState<NHIData | null>(null);

  const handleTabChange = useCallback((t: TabId) => {
    setTab(t);
    const params = new URLSearchParams(typeof window !== "undefined" ? window.location.search : "");
    params.set("tab", t);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }, [router, pathname]);

  const fetchLive = useCallback(async () => {
    try {
      const r = await fetch(`/api/network/stats/live?network=${network}`, { signal: AbortSignal.timeout(18_000) });
      if (!r.ok) return;
      const j = await r.json() as Record<string, unknown>;
      const d = j.data ?? j;
      if (isLiveSnap(d)) {
        if (alive.current) { setSnap(d); setLoading(false); }
        if (alive.current) setSeries(prev => {
          const pt: TsPoint = {
            tsMs:             Date.now(),
            activeBlobs:      num(d.activeBlobs),
            totalStorageGB:   num(d.totalStorageGB),
            totalBlobEvents:  num(d.totalBlobEvents),
            pendingOrFailed:  num(d.pendingOrFailed),
            deletedBlobs:     num(d.deletedBlobs),
            blockHeight:      num(d.blockHeight),
            storageProviders: num(d.storageProviders),
          };
          const next = [...prev, pt];
          return next.length > MAX_POINTS ? next.slice(-MAX_POINTS) : next;
        });
      }
    } catch { /* silent */ }
    finally { if (alive.current) setLoading(false); }
  }, [network]);

  const fetchNHI = useCallback(async () => {
    try {
      const r = await fetch(`/api/network/health?network=${network}`, { signal: AbortSignal.timeout(10_000) });
      if (r.ok) {
        const j = await r.json() as NHIData;
        if (alive.current && typeof j.nhi === "number") setNhi(j);
      }
    } catch { /* silent */ }
  }, [network]);

  useEffect(() => {
    if (alive.current) { setSnap(null); setSeries([]); setLoading(true); }
    fetchLive(); fetchNHI();
    const id1 = setInterval(fetchLive, POLL_MS);
    const id2 = setInterval(fetchNHI, 60_000);
    return () => { clearInterval(id1); clearInterval(id2); };
  }, [fetchLive, fetchNHI]);

  const TABS: { id: TabId; label: string; icon: string }[] = [
    { id:"overview",   label:"Overview",   icon:"◈" },
    { id:"timeseries", label:"Timeseries", icon:"▲" },
    { id:"epoch",      label:"Epoch",      icon:"⬡" },
    { id:"benchmark",  label:"Benchmark",  icon:"⚡" },
    { id:"expiry",     label:"Expiry Monitor", icon:"⏳" },
    { id:"changelog",  label:"Changelog",  icon:"▤" },
  ];

  return (
    <div style={{ maxWidth:1400, margin:"0 auto", padding:"0 4px" }}>
      <style>{`@media(max-width:768px){.nw-header{flex-direction:column!important;gap:8px!important}.nw-meta{flex-wrap:wrap!important}}`}</style>

      {/* Header */}
      <div className="nw-header" style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:18, flexWrap:"wrap", gap:10 }}>
        <div>
          <h1 style={{ fontSize:26, fontWeight:800, color:"var(--text-primary)", margin:0, letterSpacing:-0.8 }}>
            {isTestnet ? "Testnet Network" : "Network Dashboard"}
          </h1>
          <p className="nw-meta" style={{ fontSize:13, color:"var(--text-muted)", margin:"5px 0 0", display:"flex", alignItems:"center", gap:6, flexWrap:"wrap" }}>
            {isTestnet ? "Shelby Testnet · Aptos Testnet RPC" : "Shelbynet"} · Poll every {POLL_MS/1000}s
            {snap?.method && <span style={{ fontSize:11, fontWeight:600, padding:"1px 7px", borderRadius:4, background:"rgba(34,197,94,0.1)", color:"#16a34a" }}>{snap.method}</span>}
          </p>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          {/* Live UTC clock — ticks every second */}
          <LiveUTCClock />
          <div style={{ display:"flex", alignItems:"center", gap:5, fontSize:12, color:"var(--text-muted)", fontFamily:"monospace" }}>
            <span style={{ width:7, height:7, borderRadius:"50%", background:loading?"var(--text-dim)":"#22c55e", boxShadow:!loading?"0 0 6px #22c55e":"none", display:"inline-block" }}/>
            {loading ? "Syncing…" : "Live"}
          </div>
          <button onClick={fetchLive} style={{ padding:"6px 14px", borderRadius:8, border:"1px solid var(--border)", background:"var(--bg-card)", fontSize:12, color:"var(--text-muted)", cursor:"pointer" }}>⟳ Refresh</button>
        </div>
      </div>

      <TestnetRetirementBanner isTestnet={isTestnet} />

      {/* Tab bar + content */}
      <div style={{ background:"var(--bg-card)", border:"1px solid var(--border)", borderRadius:14, overflow:"hidden" }}>
        <div style={{ display:"flex", borderBottom:"1px solid var(--border)", background:"var(--bg-card2)", overflowX:"auto" }}>
          {TABS.map(t => (
            <button key={t.id} onClick={()=>handleTabChange(t.id)} style={{ padding:"13px 22px", fontSize:13, fontWeight:tab===t.id?700:500, border:"none", cursor:"pointer", whiteSpace:"nowrap", background:tab===t.id?"var(--bg-card)":"transparent", color:tab===t.id?"var(--text-primary)":"var(--text-muted)", borderBottom:tab===t.id?`2px solid ${accentColor}`:"2px solid transparent", display:"flex", alignItems:"center", gap:6 }}>
              <span style={{ opacity:0.6, fontSize:12 }}>{t.icon}</span> {t.label}
            </button>
          ))}
        </div>
        <div style={{ padding:"22px 24px" }}>
          {tab==="overview"   && <OverviewTab network={network} snap={snap} series={series} loading={loading} nhi={nhi} isTestnet={isTestnet} accentColor={accentColor} />}
          {tab==="timeseries" && <TimeseriesTab network={network} isTestnet={isTestnet} accentColor={accentColor} />}
          {tab==="epoch"      && <EpochTab network={network} />}
          {tab==="benchmark"  && <BenchmarkTab />}
          {tab==="expiry"     && <BlobExpiryMonitor network={network} />}
          {tab==="changelog"  && <ChangelogPanel network={network} />}
        </div>
      </div>

      <div style={{ marginTop:14, fontSize:11, color:"var(--text-dim)", fontFamily:"monospace", textAlign:"right" }}>
        {isTestnet ? "Source: Aptos Testnet REST API · Total Blobs = is_written=1" : "Source: Shelby Dedicated Indexer · Total Blobs = is_written=1 (matches shelby.xyz Explorer)"}
      </div>

      <Suspense fallback={null}>
        <TabReader onTab={t=>setTab(t)} />
      </Suspense>
    </div>
  );
}