// app/api/v1/blobs/expiring/route.ts
//
// Pure edge proxy per project convention — no data processing here, just
// forwards query params to the VPS backend and relays the response.
export const runtime = "edge";

const BACKEND_BASE_URL = process.env.SHELBY_API_URL; // e.g. https://api.shelbyanalytics.site

export async function GET(request: Request): Promise<Response> {
  if (!BACKEND_BASE_URL) {
    return Response.json({ error: "SHELBY_API_URL is not configured." }, { status: 500 });
  }

  const incomingUrl = new URL(request.url);
  const upstreamUrl = new URL("/v1/blobs/expiring", BACKEND_BASE_URL);
  upstreamUrl.search = incomingUrl.search;

  const upstreamResponse = await fetch(upstreamUrl.toString(), {
    // NEVER cache: "no-store" here — confirmed to silently corrupt responses
    // on CF Pages edge runtime. This is the correct equivalent.
    next: { revalidate: 0 },
  });

  const body = await upstreamResponse.text();

  return new Response(body, {
    status: upstreamResponse.status,
    headers: { "Content-Type": "application/json" },
  });
}