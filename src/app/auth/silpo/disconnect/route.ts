import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { deleteConnection } from "@/lib/silpo/oauth";

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.redirect(new URL("/?auth=required", request.url), 303);
  await deleteConnection(user.id);
  return NextResponse.redirect(new URL("/profile?silpo=disconnected", request.url), 303);
}
