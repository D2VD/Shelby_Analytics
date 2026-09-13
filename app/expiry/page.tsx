// app/expiry/page.tsx
import { BlobExpiryMonitor } from "@/components/blob-expiry-monitor";

export default function ExpiryPage() {
  return (
    <main style={{ padding: "2rem" }}>
      <h1>Blob Expiry Monitor</h1>
      <BlobExpiryMonitor network="shelbynet" />
    </main>
  );
}