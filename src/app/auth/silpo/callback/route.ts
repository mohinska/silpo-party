import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { exchangeAuthorizationCode } from "@/lib/silpo/oauth";

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.redirect(new URL("/?auth=required", request.url));
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state || url.searchParams.has("error")) {
    return NextResponse.redirect(new URL("/profile?silpo=denied", request.url));
  }
  try {
    await exchangeAuthorizationCode(user.id, state, code);
    return NextResponse.redirect(new URL("/profile?silpo=connected", request.url));
  } catch (error) {
    console.error("Silpo OAuth callback failed", error);
    return NextResponse.redirect(new URL("/profile?silpo=callback_error", request.url));
  }
}
