import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { createAuthorization } from "@/lib/silpo/oauth";

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const user = await getCurrentUser();
  if (!user) return NextResponse.redirect(new URL("/?auth=required", request.url));
  const requestedNext = requestUrl.searchParams.get("next") ?? "/parties";
  const next = requestedNext.startsWith("/") && !requestedNext.startsWith("//") ? requestedNext : "/parties";
  try {
    const origin = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? requestUrl.origin;
    const authorizationUrl = await createAuthorization(user.id, `${origin}/auth/silpo/callback?next=${encodeURIComponent(next)}`);
    return NextResponse.redirect(authorizationUrl);
  } catch (error) {
    console.error("Unable to start Silpo OAuth", error);
    return NextResponse.redirect(new URL(`/setup/silpo?next=${encodeURIComponent(next)}&silpo=connect_error`, request.url));
  }
}
