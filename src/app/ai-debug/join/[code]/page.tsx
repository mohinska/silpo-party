import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { createDebugPartyApplication } from "@/lib/ai/debug-party/application";
import { DebugCodeSchema } from "../../form-schemas";

export default async function JoinDebugPartyPage({ params }: { params: Promise<{ code: string }> }) {
  const user = await requireUser();
  const parsed = DebugCodeSchema.safeParse((await params).code);
  if (!parsed.success) notFound();
  const code = await (await createDebugPartyApplication()).joinParty(parsed.data, user.id);
  redirect(`/ai-debug/party/${code}`);
}
