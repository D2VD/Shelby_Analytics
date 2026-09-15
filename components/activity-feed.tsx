// components/activity-feed.tsx
// Real-time SSE activity feed — connects directly to VPS /api/v1/activity/stream
// Priority 2: SSE Activity Feed
//
// Usage:
//   <ActivityFeed network="shelbynet" />
//   <ActivityFeed network="testnet" showHeartbeat />
//
// Env var needed (Next.js NEXT_PUBLIC_):
//   NEXT_PUBLIC_VPS_API_URL=https://api.shelbyanalytics.site

"use client";

import { useEffect, useRef, useState } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────

type EventKind =
  | "connected"
  | "sp_health_change"
  | "sp_joined"
  | "sp_left"
  | "epoch_transition"
  | "blob_registered"
  | "blob_pending"
  | "blob_activated"
  | "blob_deleted"
  | "heartbeat";

interface ActivityEvent {
  id:        string;
  kind:      EventKind;
  timestamp: string;
  payload:   Record<string, unknown>;
}

// ── Event display config ──────────────────────────────────────────────────────

interface EventCfg {
  icon:    string;
  label:   (p: Record<string, unknown>) => string;
  color:   string;
  visible: boolean | "heartbeat";
}

const EVENT_CFG: Record<EventKind, EventCfg> = {
  connected: {
    icon:    "✓",
    label:   (p) => `Connected to ${String(p["network"] ?? "")} feed`,
    color:   "text-green-400/70",
    visible: true,
  },
  sp_health_change: {
    icon:    "⚡",
    label:   (p) => {
      const addr = String(p["address"] ?? "");
      const short = `${addr.slice(0, 6)}...${addr.slice(-4)}`;
      return `SP ${short} ${String(p["from"] ?? "")} → ${String(p["to"] ?? "")}`;
    },
    color:   "text-yellow-400",
    visible: true,
  },
  sp_joined: {
    icon:    "🟢",
    label:   (p) => {
      const addr = String(p["address"] ?? "");
      return `New SP joined: ${addr.slice(0, 6)}...${addr.slice(-4)}`;
    },
    color:   "text-green-400",
    visible: true,
  },
  sp_left: {
    icon:    "🔴",
    label:   (p) => {
      const addr = String(p["address"] ?? "");
      return `SP left: ${addr.slice(0, 6)}...${addr.slice(-4)}`;
    },
    color:   "text-red-400",
    visible: true,
  },
  epoch_transition: {
    icon:    "🔄",
    label:   (p) =>
      `${String(p["epochType"] ?? "")} epoch advanced to #${String(p["epoch"] ?? "")}`,
    color:   "text-blue-400",
    visible: true,
  },
  blob_registered: {
    icon:    "🗂",
    label:   (p) => `Blob registered: ${String(p["blobName"] ?? "")}`,
    color:   "text-pink-400",
    visible: true,
  },
  blob_pending: {
    icon:    "⏳",
    label:   (p) => `Blob pending: ${String(p["blobName"] ?? "")}`,
    color:   "text-yellow-400",
    visible: true,
  },

  blob_activated: {
    icon:    "✅",
    label:   (p) => `Blob activated: ${String(p["blobName"] ?? "")}`,
    color:   "text-emerald-400",
    visible: true,
  },

  blob_deleted: {
    icon:    "🗑",
    label:   (p) => `Blob deleted: ${String(p["blobName"] ?? "")}`,
    color:   "text-red-400",
    visible: true,
  },
  heartbeat: {
    icon:    "·",
    label:   () => "Heartbeat",
    color:   "text-white/20",
    visible: "heartbeat",
  },
};

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_EVENTS = 50;
// NEXT_PUBLIC_ so the browser can read it
const VPS_BASE =
  typeof process !== "undefined"
    ? process.env["NEXT_PUBLIC_VPS_API_URL"] ?? "https://api.shelbyanalytics.site"
    : "https://api.shelbyanalytics.site";

// ── Component ─────────────────────────────────────────────────────────────────

interface ActivityFeedProps {
  network?:       string;
  /** Show raw heartbeat ticks in the list (default false) */
  showHeartbeat?: boolean;
  /** Pixel height for the scrollable event list (default 400) */
  height?:        number;
  /** Extra Tailwind classes on the root element */
  className?:     string;
  /** Fired for every received event (including filtered-out heartbeats),
   *  in addition to internal list rendering — lets a parent (e.g. the
   *  Blobs Explorer tab) react to blob_registered/pending/deleted without
   *  opening a second EventSource connection. */
  onEvent?:       (kind: EventKind, payload: Record<string, unknown>) => void;
}

export function ActivityFeed({
  network       = "shelbynet",
  showHeartbeat = false,
  height        = 400,
  className     = "",
  onEvent,
}: ActivityFeedProps) {
  const [events,    setEvents]    = useState<ActivityEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [retryMsg,  setRetryMsg]  = useState<string | null>(null);
  const esRef   = useRef<EventSource | null>(null);
  const counter = useRef(0);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    let mounted = true;

    function connect() {
      if (!mounted) return;

      const url = `${VPS_BASE}/api/v1/activity/stream?network=${encodeURIComponent(network)}`;
      const es   = new EventSource(url);
      esRef.current = es;

      es.onopen = () => {
        if (!mounted) return;
        setConnected(true);
        setRetryMsg(null);
      };

      es.onerror = () => {
        if (!mounted) return;
        setConnected(false);
        setRetryMsg("Reconnecting...");
        es.close();
        // SSE auto-reconnects; just update UI
      };

      function push(kind: EventKind, raw: string) {
        if (!mounted) return;
        const cfg = EVENT_CFG[kind];
        if (!cfg) return;
        if (cfg.visible === "heartbeat" && !showHeartbeat) return;

        let payload: Record<string, unknown> = {};
        try { payload = JSON.parse(raw); } catch { payload = { raw }; }

        onEventRef.current?.(kind, payload);

        const event: ActivityEvent = {
          id:        String(counter.current++),
          kind,
          timestamp: (payload["timestamp"] as string | undefined) ?? new Date().toISOString(),
          payload,
        };

        setEvents((prev) => [event, ...prev].slice(0, MAX_EVENTS));
      }

      es.addEventListener("connected",        (e) => push("connected",        e.data));
      es.addEventListener("sp_health_change", (e) => push("sp_health_change", e.data));
      es.addEventListener("sp_joined",        (e) => push("sp_joined",        e.data));
      es.addEventListener("sp_left",          (e) => push("sp_left",          e.data));
      es.addEventListener("epoch_transition", (e) => push("epoch_transition", e.data));
      es.addEventListener("blob_registered",  (e) => push("blob_registered",  e.data));
      es.addEventListener("blob_pending",     (e) => push("blob_pending",     e.data));
      es.addEventListener("blob_activated",   (e) => push("blob_activated",  e.data));
      es.addEventListener("blob_deleted",     (e) => push("blob_deleted",     e.data));
      es.addEventListener("heartbeat",        (e) => push("heartbeat",        JSON.stringify({ timestamp: e.data })));
    }

    connect();

    return () => {
      mounted = false;
      esRef.current?.close();
      esRef.current = null;
    };
  }, [network, showHeartbeat]);

  return (
    <div className={`flex flex-col rounded-xl border border-white/10 bg-white/5 overflow-hidden ${className}`}>
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/10 shrink-0">
        <div className="flex items-center gap-2">
          <span
            className={`w-2 h-2 rounded-full transition-colors ${
              connected ? "bg-green-400 animate-pulse" : "bg-red-400/60"
            }`}
          />
          <span className="text-xs font-mono text-white/50">
            {connected ? "Live" : retryMsg ?? "Connecting..."}
          </span>
        </div>
        <span className="text-xs text-white/25 font-mono tabular-nums">
          {events.length}/{MAX_EVENTS}
        </span>
      </div>

      {/* ── Event list ──────────────────────────────────────────────────── */}
      <div
        className="overflow-y-auto divide-y divide-white/5 flex-1"
        style={{ height }}
      >
        {events.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-white/25">
            <span className="text-2xl">📡</span>
            <p className="text-sm">Waiting for network events...</p>
          </div>
        )}

        {events.map((ev) => {
          const cfg = EVENT_CFG[ev.kind];
          if (!cfg) return null;

          return (
            <div
              key={ev.id}
              className="flex items-start gap-3 px-4 py-2.5 hover:bg-white/5 transition-colors"
            >
              {/* Icon */}
              <span className="text-sm w-4 text-center mt-0.5 shrink-0 select-none">
                {cfg.icon}
              </span>

              {/* Content */}
              <div className="flex-1 min-w-0">
                <p className={`text-xs truncate ${cfg.color}`}>
                  {cfg.label(ev.payload)}
                </p>
                <p className="text-xs text-white/25 mt-0.5 font-mono">
                  {new Date(ev.timestamp).toLocaleTimeString("en-US", {
                    hour:   "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}