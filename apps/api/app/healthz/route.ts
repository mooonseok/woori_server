export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(
    { service: "woori-api", status: "alive", implementation: "bootstrap", featuresReady: false },
    { headers: { "Cache-Control": "no-store" } },
  );
}
