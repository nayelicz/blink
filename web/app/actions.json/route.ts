import { ACTIONS_CORS_HEADERS, type ActionsJson } from "@solana/actions";

export const dynamic = "force-dynamic";
export const runtime = "edge";

/**
 * actions.json — registers the URL patterns that Blink/Dial.to clients should
 * treat as Solana Actions on this domain. See the Solana Actions spec:
 * https://docs.dialect.to/documentation/actions/specification/actions.json
 */
const payload: ActionsJson = {
  rules: [
    { pathPattern: "/api/actions/cashout", apiPath: "/api/actions/cashout" },
    { pathPattern: "/api/actions/verify", apiPath: "/api/actions/verify" },
    { pathPattern: "/blink/cashout", apiPath: "/api/actions/cashout" },
    { pathPattern: "/blink/verify", apiPath: "/api/actions/verify" },
  ],
};

export async function GET() {
  return Response.json(payload, { headers: ACTIONS_CORS_HEADERS });
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: ACTIONS_CORS_HEADERS });
}
