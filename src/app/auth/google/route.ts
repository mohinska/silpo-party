import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const origin = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? requestUrl.origin;
  const requestedNext = requestUrl.searchParams.get("next") ?? "/parties";
  const next = requestedNext.startsWith("/") && !requestedNext.startsWith("//")
    ? requestedNext
    : "/parties";
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: `${origin}/auth/callback?next=${encodeURIComponent(next)}` },
  });
  if (error || !data.url) {
    return NextResponse.redirect(`${origin}/?auth=google_error`);
  }
  return NextResponse.redirect(data.url);
}
