import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Gates the whole deployed app (pages + API routes, so nobody can bypass the UI and hit the
 * research endpoints directly) behind a single shared password via HTTP Basic Auth — no login
 * page, just the browser's native prompt. SITE_PASSWORD is unset locally, so `npm run dev` stays
 * gate-free; set it only on the Railway deployment to restrict that instance to just you.
 */
export function middleware(req: NextRequest) {
  const password = process.env.SITE_PASSWORD;
  if (!password) return NextResponse.next();

  const auth = req.headers.get("authorization");
  const supplied = auth?.startsWith("Basic ") ? atob(auth.slice(6)).split(":")[1] : undefined;
  if (supplied === password) return NextResponse.next();

  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Blindspot"' },
  });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
