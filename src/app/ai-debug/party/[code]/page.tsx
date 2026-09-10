import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { createDebugPartyApplication } from "@/lib/ai/debug-party/application";
import { getConnectionStatus } from "@/lib/silpo/oauth";
import { DebugCodeSchema } from "../../form-schemas";
import { WorkspaceClient } from "./workspace-client";

export default async function DebugPartyPage({ params }: { params: Promise<{ code: string }> }) {
  const user = await requireUser();
  const parsed = DebugCodeSchema.safeParse((await params).code);
  if (!parsed.success) notFound();
  const [workspace, connection] = await Promise.all([
    (await createDebugPartyApplication()).loadWorkspace(parsed.data, user.id),
    getConnectionStatus(user.id).catch(() => null),
  ]);
  return <WorkspaceClient workspace={workspace} mcpConnected={Boolean(connection)} />;
}
