export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(
    { status: "not_ready", code: "BOOTSTRAP_ONLY" },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}
