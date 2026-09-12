import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getConnectionStatus } from "@/lib/silpo/oauth";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const origin = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? url.origin;
  const code = url.searchParams.get("code");
  const requestedNext = url.searchParams.get("next") ?? "/parties";
  const next = requestedNext.startsWith("/") && !requestedNext.startsWith("//")
    ? requestedNext
    : "/parties";
  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      const { data: { user } } = await supabase.auth.getUser();
      const connected = user ? await getConnectionStatus(user.id).catch(() => null) : null;
      return NextResponse.redirect(`${origin}${connected ? next : `/setup/silpo?next=${encodeURIComponent(next)}`}`);
    }
  }
  return NextResponse.redirect(`${origin}/?auth=callback_error`);
}
