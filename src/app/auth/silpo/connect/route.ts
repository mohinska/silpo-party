import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { createAuthorization } from "@/lib/silpo/oauth";

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.redirect(new URL("/?auth=required", request.url));
  try {
    const origin = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? new URL(request.url).origin;
    const authorizationUrl = await createAuthorization(user.id, `${origin}/auth/silpo/callback`);
    return NextResponse.redirect(authorizationUrl);
  } catch (error) {
    console.error("Unable to start Silpo OAuth", error);
    return NextResponse.redirect(new URL("/profile?silpo=connect_error", request.url));
  }
}
