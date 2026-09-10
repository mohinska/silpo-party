import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { createDebugPartyApplication } from "@/lib/ai/debug-party/application";
import { DebugCodeSchema } from "../../form-schemas";
import styles from "../../page.module.css";

export default async function DebugPartyPage({ params }: { params: Promise<{ code: string }> }) {
  const user = await requireUser();
  const parsed = DebugCodeSchema.safeParse((await params).code);
  if (!parsed.success) notFound();
  const workspace = await (await createDebugPartyApplication()).loadWorkspace(parsed.data, user.id);
  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <Link href="/ai-debug" className={styles.backLink}>Усі вечірки</Link>
        <h1>Вечірка {workspace.party.code}</h1>
        <p>Учасників: {workspace.members.length} · Код: {workspace.party.code}</p>
        <Link href={`/ai-debug/join/${workspace.party.code}`}>Посилання для запрошення</Link>
      </header>
    </main>
  );
}
