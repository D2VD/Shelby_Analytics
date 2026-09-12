"use client";

// components/blob-expiry-monitor.tsx
//
// If lib/utils.ts already exports str()/num() helpers, import them from there
// instead of the local copies below — the house convention is one shared
// implementation, not a per-component reimplementation.
import { useEffect, useState } from "react";

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

type Bucket = "expiring" | "overdue";

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

interface BlobExpiryMonitorProps {
  network?: string;
}

export function BlobExpiryMonitor({ network = "shelbynet" }: BlobExpiryMonitorProps) {
  const [windowValue, setWindowValue] = useState<"7d" | "30d">("7d");
  const [address, setAddress] = useState("");
  const [data, setData] = useState<BlobExpiringResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

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

  return (
    <div className="blob-expiry-monitor">
      <div className="blob-expiry-monitor__controls">
        {WINDOW_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => setWindowValue(option.value)}
            aria-pressed={windowValue === option.value}
          >
            {option.label}
          </button>
        ))}
        <input
          type="text"
          placeholder="Filter by owner address (optional)"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
        />
      </div>

      {isLoading && <p>Loading expiring blobs…</p>}
      {error && <p role="alert">{error}</p>}

      {data && !isLoading && !error && (
        <>
          <div className="blob-expiry-monitor__summary">
            <div className="blob-expiry-monitor__stat">
              <span>Expiring within {data.window === "7d" ? "7 days" : "30 days"}</span>
              <strong>{num(data.count).toLocaleString("en-US")} blobs</strong>
              <span>
                {num(data.totalGBExpiring).toLocaleString("en-US", { maximumFractionDigits: 2 })} GB
                {" "}
                ({num(data.totalGiBExpiring).toLocaleString("en-US", { maximumFractionDigits: 2 })} GiB)
              </span>
            </div>
            <div className="blob-expiry-monitor__stat blob-expiry-monitor__stat--overdue">
              <span>Overdue (should have expired, still marked active)</span>
              <strong>{num(data.overdueCount).toLocaleString("en-US")} blobs</strong>
              <span>
                {num(data.overdueGBTotal).toLocaleString("en-US", { maximumFractionDigits: 2 })} GB
                {" "}
                ({num(data.overdueGiBTotal).toLocaleString("en-US", { maximumFractionDigits: 2 })} GiB)
              </span>
            </div>
          </div>

          {data.blobs && data.blobs.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>Blob name</th>
                  <th>Size</th>
                  <th>Expires at</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.blobs.map((blob) => (
                  <tr key={`${blob.txVersion}-${blob.blobName}`}>
                    <td>{str(blob.blobName)}</td>
                    <td>
                      {(num(blob.sizeBytes) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 3 })} GB
                    </td>
                    <td>{new Date(blob.expiresAt).toLocaleString("en-US")}</td>
                    <td>{blob.bucket === "overdue" ? "Overdue" : "Expiring soon"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}