"use client";

// components/blob-expiry-monitor.tsx
//
// Styled to match this project's existing inline-style / CSS-variable
// convention (see app/network/page.tsx's StatCard, BlobBreakdown, and
// BenchmarkTab for the patterns mirrored here) rather than external
// classNames, since no stylesheet in this project defines the
// blob-expiry-monitor__* classes the original draft used.
//
// Chart uses echarts-for-react via next/dynamic({ ssr:false }), matching
// this project's existing charting convention (see network-context /
// timeseries charts elsewhere in the app).
//
// If lib/utils.ts already exports str()/num() helpers, import them from there
// instead of the local copies below — the house convention is one shared
// implementation, not a per-component reimplementation. Left as local copies
// here since lib/utils.ts's exact exports weren't available to check.
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import dynamic from "next/dynamic";

const ReactECharts = dynamic(() => import("echarts-for-react"), { ssr: false });

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function fmtGBGiB(bytes: number): string {
  const gb = bytes / 1e9;
  const gib = bytes / 1024 ** 3;
  return `${gb.toLocaleString("en-US", { maximumFractionDigits: 2 })} GB (${gib.toLocaleString("en-US", { maximumFractionDigits: 2 })} GiB)`;
}

function fmtPct(part: number, total: number): string {
  if (total <= 0) return "0%";
  return `${((part / total) * 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}%`;
}

type Bucket = "expiring" | "overdue";
type SortKey = "expiresAt" | "size";
type SortDir = "asc" | "desc";

interface ExpiringBlob {
  blobName: string;
  txVersion: string;
  sizeBytes: number;
  expiresAt: string;
  bucket: Bucket;
}

interface BlobExpiringResponse {
  network: string;
  window: "7d" | "30d";
  address: string | null;
  count: number;
  totalBytesExpiring: number;
  totalGBExpiring: number;
  totalGiBExpiring: number;
  overdueCount: number;
  overdueBytesTotal: number;
  overdueGBTotal: number;
  overdueGiBTotal: number;
  blobs?: ExpiringBlob[];
  updatedAt: string;
}

function isBlobExpiringResponse(value: unknown): value is BlobExpiringResponse {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.network === "string" && typeof candidate.count === "number";
}

const WINDOW_OPTIONS = [
  { label: "Next 7 days", value: "7d" as const },
  { label: "Next 30 days", value: "30d" as const },
];

const COLOR_EXPIRING = "#0891b2";
const COLOR_OVERDUE = "#f59e0b";

interface BlobExpiryMonitorProps {
  network?: string;
}

export function BlobExpiryMonitor({ network = "shelbynet" }: BlobExpiryMonitorProps) {
  const [windowValue, setWindowValue] = useState<"7d" | "30d">("7d");
  const [address, setAddress] = useState("");
  const [data, setData] = useState<BlobExpiringResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey>("expiresAt");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  useEffect(() => {
    let isCancelled = false;

    async function loadExpiringBlobs() {
      setIsLoading(true);
      setError(null);

      const params = new URLSearchParams({ network, window: windowValue });
      const trimmedAddress = address.trim();
      if (trimmedAddress.length > 0) {
        params.set("address", trimmedAddress);
      }

      try {
        const response = await fetch(`/api/v1/blobs/expiring?${params.toString()}`, {
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
        if (!isBlobExpiringResponse(parsed)) {
          throw new Error("Unexpected response shape from /v1/blobs/expiring.");
        }

        if (!isCancelled) {
          setData(parsed);
        }
      } catch (caughtError) {
        if (!isCancelled) {
          setError(caughtError instanceof Error ? caughtError.message : "Failed to load expiring blobs.");
          setData(null);
        }
      } finally {
        if (!isCancelled) {
          setIsLoading(false);
        }
      }
    }

    loadExpiringBlobs();

    return () => {
      isCancelled = true;
    };
  }, [network, windowValue, address]);

  const total = data ? num(data.count) + num(data.overdueCount) : 0;
  const isEmpty = data != null && total === 0;

  const sortedBlobs = useMemo(() => {
    if (!data?.blobs) return [];
    const items = [...data.blobs];
    items.sort((a, b) => {
      const cmp =
        sortKey === "size"
          ? num(a.sizeBytes) - num(b.sizeBytes)
          : new Date(a.expiresAt).getTime() - new Date(b.expiresAt).getTime();
      return sortDir === "asc" ? cmp : -cmp;
    });
    return items;
  }, [data, sortKey, sortDir]);

  function handleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  function sortArrow(key: SortKey) {
    if (sortKey !== key) return "";
    return sortDir === "asc" ? " ▲" : " ▼";
  }

  const chartOption = {
    tooltip: {
      trigger: "item",
      confine: true,
      formatter: (p: { name: string; value: number; percent: number }) =>
        `${p.name}: ${num(p.value).toLocaleString("en-US")} (${p.percent}%)`,
      position: (
        point: [number, number],
        _params: unknown,
        _dom: unknown,
        _rect: unknown,
        size: { viewSize: [number, number]; contentSize: [number, number] }
      ) => {
        // Always render below the donut, horizontally centered — never on
        // top of the ring itself, regardless of which slice is hovered.
        const x = Math.max(0, (size.viewSize[0] - size.contentSize[0]) / 2);
        const y = size.viewSize[1] + 10;
        return [x, y];
      },
    },
    color: [COLOR_EXPIRING, COLOR_OVERDUE],
    series: [
      {
        type: "pie",
        radius: ["64%", "88%"],
        avoidLabelOverlap: true,
        label: { show: false },
        labelLine: { show: false },
        emphasis: { scale: true, scaleSize: 4 },
        data: [
          { value: data ? num(data.count) : 0, name: "Expiring soon" },
          { value: data ? num(data.overdueCount) : 0, name: "Overdue" },
        ],
      },
    ],
  };

  const thStyle = (key: SortKey | null): CSSProperties => ({
    padding: "9px 13px",
    textAlign: "left",
    fontSize: 10,
    fontWeight: 600,
    color: key && sortKey === key ? "var(--text-primary)" : "var(--text-dim)",
    textTransform: "uppercase",
    letterSpacing: "0.07em",
    whiteSpace: "nowrap",
    borderBottom: "1px solid var(--border)",
    cursor: key ? "pointer" : "default",
    userSelect: "none",
  });

  return (
    <div>
      {/* Controls */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 18, flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 3, background: "var(--bg-card2)", border: "1px solid var(--border)", borderRadius: 8, padding: 3 }}>
          {WINDOW_OPTIONS.map((option) => {
            const active = windowValue === option.value;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => setWindowValue(option.value)}
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
        <input
          type="text"
          placeholder="Filter by owner address (optional)"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          style={{
            flex: "1 1 280px",
            minWidth: 220,
            padding: "8px 13px",
            borderRadius: 8,
            border: "1px solid var(--border)",
            background: "var(--bg-card2)",
            color: "var(--text-primary)",
            fontSize: 13,
            fontFamily: "monospace",
          }}
        />
      </div>

      {isLoading && (
        <div style={{ padding: 32, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
          Loading expiring blobs…
        </div>
      )}

      {error && (
        <div role="alert" style={{ padding: 32, textAlign: "center", color: "#ef4444", fontSize: 13 }}>
          ⚠ {error}
        </div>
      )}

      {data && !isLoading && !error && (
        <>
          {isEmpty ? (
            <div style={{ padding: 28, textAlign: "center", color: "var(--text-muted)", fontSize: 13, background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 14, marginBottom: 20 }}>
              No expiring or overdue blobs found{data.address ? " for this address" : ""} in this window.
            </div>
          ) : (
            <div style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 14, padding: "20px 22px", marginBottom: 20 }}>
              <div style={{ display: "flex", gap: 26, alignItems: "center", flexWrap: "wrap" }}>
                <div style={{ position: "relative", width: 168, height: 168, flexShrink: 0 }}>
                  <ReactECharts option={chartOption} style={{ height: 168, width: 168 }} opts={{ renderer: "svg" }} />
                  <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
                    <div style={{ fontSize: 22, fontWeight: 800, fontFamily: "monospace", color: "var(--text-primary)", lineHeight: 1.1 }}>
                      {total.toLocaleString("en-US")}
                    </div>
                    <div style={{ fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em", marginTop: 2 }}>
                      tracked
                    </div>
                  </div>
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 16, flex: 1, minWidth: 240 }}>
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ width: 10, height: 10, borderRadius: 3, background: COLOR_EXPIRING, flexShrink: 0 }} />
                      <span style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", fontWeight: 600 }}>
                        Expiring within {data.window === "7d" ? "7 days" : "30 days"}
                      </span>
                    </div>
                    <div style={{ fontSize: 22, fontWeight: 800, fontFamily: "monospace", color: "var(--text-primary)", marginTop: 4 }}>
                      {num(data.count).toLocaleString("en-US")} blobs
                      <span style={{ fontSize: 12, fontWeight: 400, color: "var(--text-muted)", marginLeft: 8 }}>
                        {fmtPct(num(data.count), total)} of tracked
                      </span>
                    </div>
                    <div style={{ fontSize: 12, color: "var(--text-muted)", fontFamily: "monospace", marginTop: 2 }}>
                      {fmtGBGiB(num(data.totalBytesExpiring))}
                    </div>
                  </div>

                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ width: 10, height: 10, borderRadius: 3, background: COLOR_OVERDUE, flexShrink: 0 }} />
                      <span style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", fontWeight: 600 }}>
                        Overdue — should have expired, still marked active
                      </span>
                    </div>
                    <div style={{ fontSize: 22, fontWeight: 800, fontFamily: "monospace", color: "var(--text-primary)", marginTop: 4 }}>
                      {num(data.overdueCount).toLocaleString("en-US")} blobs
                      <span style={{ fontSize: 12, fontWeight: 400, color: "var(--text-muted)", marginLeft: 8 }}>
                        {fmtPct(num(data.overdueCount), total)} of tracked
                      </span>
                    </div>
                    <div style={{ fontSize: 12, color: "var(--text-muted)", fontFamily: "monospace", marginTop: 2 }}>
                      {fmtGBGiB(num(data.overdueBytesTotal))}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Detail table */}
          {data.blobs && data.blobs.length > 0 && (
            <div style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderBottom: "1px solid var(--border)" }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-primary)" }}>Blob Detail</div>
                <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{data.blobs.length.toLocaleString("en-US")} shown</div>
              </div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: "var(--bg-card2)" }}>
                      <th style={thStyle(null)}>Blob name</th>
                      <th style={thStyle("size")} onClick={() => handleSort("size")}>
                        Size{sortArrow("size")}
                      </th>
                      <th style={thStyle("expiresAt")} onClick={() => handleSort("expiresAt")}>
                        Expires at{sortArrow("expiresAt")}
                      </th>
                      <th style={thStyle(null)}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedBlobs.map((blob) => {
                      const overdue = blob.bucket === "overdue";
                      return (
                        <tr key={`${blob.txVersion}-${blob.blobName}`} style={{ borderTop: "1px solid var(--border-soft)" }}>
                          <td
                            style={{ padding: "8px 13px", fontFamily: "monospace", fontSize: 12, color: "var(--text-muted)", maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                            title={str(blob.blobName)}
                          >
                            {str(blob.blobName)}
                          </td>
                          <td style={{ padding: "8px 13px", fontFamily: "monospace", fontSize: 12, color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                            {fmtGBGiB(num(blob.sizeBytes))}
                          </td>
                          <td style={{ padding: "8px 13px", fontSize: 12, color: "var(--text-dim)", fontFamily: "monospace", whiteSpace: "nowrap" }}>
                            {new Date(blob.expiresAt).toLocaleString("en-US")}
                          </td>
                          <td style={{ padding: "8px 13px", whiteSpace: "nowrap" }}>
                            <span
                              style={{
                                fontSize: 11,
                                fontWeight: 700,
                                padding: "2px 9px",
                                borderRadius: 999,
                                background: overdue ? "rgba(239,68,68,0.12)" : "rgba(8,145,178,0.12)",
                                color: overdue ? "#ef4444" : COLOR_EXPIRING,
                              }}
                            >
                              {overdue ? "Overdue" : "Expiring soon"}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}