"use client";

// components/changelog-panel.tsx
//
// Public Changelog (C4) — curated feed of significant network events
// (SP joins/leaves, payment/staking epoch transitions — deliberately
// excludes hourly audit-epoch ticks, blob registration/deletion, and
// health flaps per explicit sign-off). Styled to match this project's
// existing inline-style / CSS-variable convention, mirroring
// blob-expiry-monitor.tsx's controls/card/list patterns.
//
// Data source: GET /api/v1/changelog (edge-proxied to the VPS backend,
// see app/api/v1/changelog/route.ts). An RSS 2.0 feed is also available
// directly from the public API — not edge-proxied through Next.js since
// feed readers hit the backend URL directly; linked here as a
// "Subscribe" affordance only.
//
// Click-to-detail (2026-09-18): each event is now clickable, opening a
// modal with the full timestamp, the raw `payload` fields in readable
// form, and a contextual link. Confirmed live via
// `GET /api/v1/changelog` that `payload` is already returned unfiltered
// (sp_joined/sp_left → { address, network }, epoch_transition →
// { epochType, epoch, network }) — no backend change needed. Links use
// existing routes with no new query-param handling required on either
// target page: SP events link to `/explorer?q={address}` (resolves to
// that address's account panel via app/explorer/page.tsx's existing `q`
// param — NOT a Leaderboard deep-link/highlight, which
// components/leaderboard-tab.tsx does not currently support); epoch
// events link to `/network?tab=epoch` (lands on the tab as a whole — no
// per-epochType sub-targeting exists in app/network/page.tsx yet, it
// only reads `tab`). If exact-row highlighting is wanted later, it needs
// new code in those two files, not this one.
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatPayloadValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  return JSON.stringify(value);
}

type FilterGroup = "all" | "sp" | "epoch";

interface ChangelogEvent {
  id: string;
  time: string;
  network: string;
  kind: string;
  summary: string;
  payload: unknown;
}

interface ChangelogResponse {
  network: string;
  count: number;
  events: ChangelogEvent[];
}

function isChangelogResponse(value: unknown): value is ChangelogResponse {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.network === "string" && Array.isArray(candidate.events);
}

function matchesFilter(kind: string, filter: FilterGroup): boolean {
  if (filter === "all") return true;
  if (filter === "sp") return kind === "sp_joined" || kind === "sp_left";
  if (filter === "epoch") return kind === "epoch_transition";
  return true;
}

const FILTER_OPTIONS: { label: string; value: FilterGroup }[] = [
  { label: "All", value: "all" },
  { label: "SP joins / leaves", value: "sp" },
  { label: "Epoch transitions", value: "epoch" },
];

const KIND_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  sp_joined: { label: "SP joined", color: "#10b981", bg: "rgba(16,185,129,0.12)" },
  sp_left: { label: "SP left", color: "#ef4444", bg: "rgba(239,68,68,0.12)" },
  epoch_transition: { label: "Epoch transition", color: "#0891b2", bg: "rgba(8,145,178,0.12)" },
};

function kindConfig(kind: string): { label: string; color: string; bg: string } {
  return KIND_CONFIG[kind] ?? { label: kind, color: "var(--text-muted)", bg: "var(--bg-card2)" };
}

// Fields that are already implied by context (network is shown elsewhere,
// or is the same for every event in this panel instance) and would be
// redundant to repeat inside the payload detail list.
const PAYLOAD_HIDDEN_FIELDS = new Set(["network"]);

const PAYLOAD_FIELD_LABELS: Record<string, string> = {
  address: "Address",
  epochType: "Epoch type",
  epoch: "Epoch number",
};

interface ContextualLink {
  href: string;
  label: string;
}

function contextualLink(event: ChangelogEvent): ContextualLink | null {
  if (!isRecord(event.payload)) return null;

  if (event.kind === "sp_joined" || event.kind === "sp_left") {
    const address = event.payload.address;
    if (typeof address !== "string" || address.length === 0) return null;
    return { href: `/explorer?q=${encodeURIComponent(address)}`, label: "View this address in Explorer" };
  }

  if (event.kind === "epoch_transition") {
    return { href: "/network?tab=epoch", label: "View Epoch tab" };
  }

  return null;
}

interface EventDetailModalProps {
  event: ChangelogEvent;
  onClose: () => void;
}

function EventDetailModal({ event, onClose }: EventDetailModalProps) {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const config = kindConfig(event.kind);
  const link = contextualLink(event);
  const payloadEntries = isRecord(event.payload)
    ? Object.entries(event.payload).filter(([key]) => !PAYLOAD_HIDDEN_FIELDS.has(key))
    : [];

  return (
    <div
      onClick={onClose}
      role="presentation"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        style={{
          background: "var(--bg-card)",
          border: "1px solid var(--border)",
          borderRadius: 14,
          maxWidth: 440,
          width: "100%",
          padding: 20,
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10, marginBottom: 14 }}>
          <span
            style={{
              fontSize: 11,
              fontWeight: 700,
              padding: "2px 9px",
              borderRadius: 999,
              background: config.bg,
              color: config.color,
              whiteSpace: "nowrap",
              marginTop: 1,
            }}
          >
            {config.label}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              background: "none",
              border: "none",
              color: "var(--text-muted)",
              fontSize: 20,
              lineHeight: 1,
              cursor: "pointer",
              padding: 2,
            }}
          >
            ×
          </button>
        </div>

        <div style={{ fontSize: 15, color: "var(--text-primary)", marginBottom: 10 }}>{str(event.summary)}</div>

        <div style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "monospace", marginBottom: 16 }}>
          {new Date(event.time).toLocaleString("en-US")} · {event.time}
        </div>

        {payloadEntries.length > 0 && (
          <div
            style={{
              background: "var(--bg-card2)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              padding: "10px 13px",
              marginBottom: link ? 16 : 0,
            }}
          >
            {payloadEntries.map(([key, value]) => (
              <div
                key={key}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 12,
                  fontSize: 12,
                  padding: "3px 0",
                }}
              >
                <span style={{ color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                  {PAYLOAD_FIELD_LABELS[key] ?? key}
                </span>
                <span
                  style={{
                    color: "var(--text-primary)",
                    fontFamily: "monospace",
                    textAlign: "right",
                    wordBreak: "break-all",
                  }}
                >
                  {formatPayloadValue(value)}
                </span>
              </div>
            ))}
          </div>
        )}

        {link && (
          <Link
            href={link.href}
            style={{
              display: "block",
              textAlign: "center",
              padding: "9px 13px",
              borderRadius: 8,
              background: "var(--accent)",
              color: "#fff",
              fontSize: 13,
              fontWeight: 600,
              textDecoration: "none",
            }}
          >
            {link.label}
          </Link>
        )}
      </div>
    </div>
  );
}

interface ChangelogPanelProps {
  network?: string;
}

export function ChangelogPanel({ network = "shelbynet" }: ChangelogPanelProps) {
  const [data, setData] = useState<ChangelogResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [filter, setFilter] = useState<FilterGroup>("all");
  const [selectedEvent, setSelectedEvent] = useState<ChangelogEvent | null>(null);

  useEffect(() => {
    let isCancelled = false;

    async function loadChangelog() {
      setIsLoading(true);
      setError(null);

      const params = new URLSearchParams({ network, limit: "50" });

      try {
        const response = await fetch(`/api/v1/changelog?${params.toString()}`, {
          next: { revalidate: 0 },
        });

        if (!response.ok) {
          const errorBody: unknown = await response.json().catch(() => null);
          const message =
            errorBody && typeof errorBody === "object" && "error" in errorBody
              ? str((errorBody as Record<string, unknown>).error)
              : "";
          throw new Error(message || `Request failed with status ${response.status}`);
        }

        const parsed: unknown = await response.json();
        if (!isChangelogResponse(parsed)) {
          throw new Error("Unexpected response shape from /v1/changelog.");
        }

        if (!isCancelled) {
          setData(parsed);
        }
      } catch (caughtError) {
        if (!isCancelled) {
          setError(caughtError instanceof Error ? caughtError.message : "Failed to load changelog.");
          setData(null);
        }
      } finally {
        if (!isCancelled) {
          setIsLoading(false);
        }
      }
    }

    loadChangelog();

    return () => {
      isCancelled = true;
    };
  }, [network]);

  const filteredEvents = useMemo(() => {
    if (!data?.events) return [];
    return data.events.filter((event) => matchesFilter(event.kind, filter));
  }, [data, filter]);

  const rssUrl = `https://api.shelbyanalytics.site/api/v1/changelog/rss?network=${encodeURIComponent(network)}`;

  return (
    <div>
      {/* Controls */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 18, flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 3, background: "var(--bg-card2)", border: "1px solid var(--border)", borderRadius: 8, padding: 3 }}>
          {FILTER_OPTIONS.map((option) => {
            const active = filter === option.value;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => setFilter(option.value)}
                aria-pressed={active}
                style={{
                  padding: "5px 13px",
                  borderRadius: 6,
                  fontSize: 12,
                  fontWeight: active ? 700 : 400,
                  border: "none",
                  cursor: "pointer",
                  background: active ? "var(--accent)" : "transparent",
                  color: active ? "#fff" : "var(--text-muted)",
                  transition: "all 0.1s",
                }}
              >
                {option.label}
              </button>
            );
          })}
        </div>

        <a
          href={rssUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "6px 13px",
            borderRadius: 8,
            border: "1px solid var(--border)",
            background: "var(--bg-card2)",
            color: "var(--text-muted)",
            fontSize: 12,
            fontWeight: 600,
            textDecoration: "none",
          }}
        >
          Subscribe (RSS)
        </a>
      </div>

      {isLoading && (
        <div style={{ padding: 32, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
          Loading changelog…
        </div>
      )}

      {error && (
        <div role="alert" style={{ padding: 32, textAlign: "center", color: "#ef4444", fontSize: 13 }}>
          ⚠ {error}
        </div>
      )}

      {data && !isLoading && !error && (
        <>
          {filteredEvents.length === 0 ? (
            <div style={{ padding: 28, textAlign: "center", color: "var(--text-muted)", fontSize: 13, background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 14 }}>
              No changelog events {filter !== "all" ? "for this filter" : "yet"}. Significant events
              (SP joins/leaves, payment and staking epoch transitions) will appear here as they
              happen.
            </div>
          ) : (
            <div style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 14, overflow: "hidden" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderBottom: "1px solid var(--border)" }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-primary)" }}>Recent Events</div>
                <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{filteredEvents.length.toLocaleString("en-US")} shown</div>
              </div>
              <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {filteredEvents.map((event) => {
                  const config = kindConfig(event.kind);
                  return (
                    <li
                      key={event.id}
                      onClick={() => setSelectedEvent(event)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setSelectedEvent(event);
                        }
                      }}
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        gap: 13,
                        padding: "12px 16px",
                        borderTop: "1px solid var(--border-soft)",
                        cursor: "pointer",
                      }}
                    >
                      <span
                        style={{
                          fontSize: 11,
                          fontWeight: 700,
                          padding: "2px 9px",
                          borderRadius: 999,
                          background: config.bg,
                          color: config.color,
                          whiteSpace: "nowrap",
                          marginTop: 1,
                        }}
                      >
                        {config.label}
                      </span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, color: "var(--text-primary)" }}>{str(event.summary)}</div>
                        <div style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "monospace", marginTop: 2 }}>
                          {new Date(event.time).toLocaleString("en-US")}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </>
      )}

      {selectedEvent && (
        <EventDetailModal event={selectedEvent} onClose={() => setSelectedEvent(null)} />
      )}
    </div>
  );
}