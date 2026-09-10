"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { DebugPartyWorkspace } from "@/lib/ai/debug-party/repository";
import { contextLabels, deriveWorkspaceUi } from "@/lib/ai/debug-party/ui-state";
import { ChatPanel } from "./chat-panel";
import { BasketPanel } from "./basket-panel";
import { DebugLog } from "./debug-log";
import { participantName } from "./participant-name";
import styles from "../../page.module.css";

export type WorkspaceProps = { workspace: DebugPartyWorkspace; mcpConnected: boolean };
export type WorkspaceUi = ReturnType<typeof deriveWorkspaceUi>;

export function WorkspaceClient({ workspace, mcpConnected }: WorkspaceProps) {
  const router = useRouter();
  const [tab, setTab] = useState<"chat" | "cart" | "log">("chat");
  const [copyStatus, setCopyStatus] = useState("");
  const { party, member, members } = workspace;
  const activeRun = workspace.runs?.find((run) => run.status === "running" || run.status === "queued");
  const ui = deriveWorkspaceUi({
    partyStatus: party.status, role: member.role, contextStatus: member.contextStatus,
    hasCartItems: workspace.cartItems.length > 0, cartStale: workspace.cartStale ?? false,
    hasSubmittedIntents: workspace.intents.length > 0,
    contextsReady: workspace.intents.every((intent) => workspace.contexts.some((context) =>
      context.participantId === intent.participantId && context.contextStatus === "ready" && context.intentRevision === intent.revision)),
    runStatus: activeRun?.status ?? null, sendStatus: workspace.sendStatus ?? null,
  });

  useEffect(() => {
    if (!ui.shouldPoll) return;
    const refresh = () => { if (document.visibilityState === "visible") router.refresh(); };
    const interval = window.setInterval(refresh, 3000);
    document.addEventListener("visibilitychange", refresh);
    return () => { window.clearInterval(interval); document.removeEventListener("visibilitychange", refresh); };
  }, [router, ui.shouldPoll]);

  async function copyInvite(link: boolean) {
    try {
      await navigator.clipboard.writeText(link ? `${window.location.origin}/ai-debug/join/${party.code}` : party.code);
      setCopyStatus(link ? "Посилання скопійовано" : "Код скопійовано");
    } catch { setCopyStatus("Не вдалося скопіювати. Виділіть код або відкрийте посилання нижче."); }
  }

  return (
    <main className={`${styles.shell} ${styles.workspaceShell}`}>
      <header className={styles.workspaceHeader}>
        <div><Link href="/ai-debug" className={styles.brand}>AI Debug Party</Link><h1>Збираємося за одним столом</h1></div>
        <span className={styles.statusPill}>{ui.frozen ? ui.cartLabel : ui.busy ? "Помічник працює" : "Вечірка відкрита"}</span>
      </header>
      <nav className={styles.tabs} aria-label="Розділи вечірки">
        {([["chat", "Чат"], ["cart", `Кошик (${workspace.snapshot?.items.length ?? workspace.cartItems.length})`], ["log", "Лог"]] as const).map(([value, label]) =>
          <button key={value} type="button" aria-pressed={tab === value} aria-controls={`party-${value}`} onClick={() => setTab(value)}>{label}</button>)}
      </nav>
      <div className={styles.workspaceGrid} data-tab={tab}>
        <aside className={styles.partyRail} aria-label="Вечірка та учасники">
          <details className={styles.partyDetails} open>
            <summary>Ваша компанія <span>{members.length}</span></summary>
            <div className={styles.invite}>
              <span>Код запрошення</span>
              <button className={styles.inviteCode} type="button" onClick={() => copyInvite(false)} aria-label={`Скопіювати код ${party.code}`}>{party.code}<span aria-hidden="true">⧉</span></button>
              <button className={styles.textButton} type="button" onClick={() => copyInvite(true)}>Копіювати посилання</button>
              <Link className={styles.smallLink} href={`/ai-debug/join/${party.code}`}>Відкрити запрошення</Link>
              <p role="status" className={styles.copyStatus}>{copyStatus}</p>
            </div>
            <ul className={styles.members}>
              {members.map((person, index) => <li key={person.participantId}>
                <span className={styles.avatar} aria-hidden="true">{index + 1}</span>
                <div><strong>{participantName(workspace, person.participantId)}{person.role === "host" && <span className={styles.hostBadge}>Host</span>}</strong><small>{contextLabels[person.contextStatus]}</small></div>
              </li>)}
            </ul>
          </details>
          <div className={styles.connection}>
            <span className={mcpConnected ? styles.connectedDot : styles.offlineDot} aria-hidden="true" />
            <div><strong>Сільпо MCP</strong><p>{mcpConnected ? "Акаунт підключено" : "Акаунт не підключено"}</p>{!mcpConnected && <Link href="/profile">Підключити в профілі</Link>}</div>
          </div>
          <p className={styles.railNote}>Перший запит підготує ваш контекст. Далі просто пишіть, що додати чи змінити.</p>
        </aside>
        <ChatPanel workspace={workspace} ui={ui} />
        <BasketPanel workspace={workspace} ui={ui} />
        <DebugLog workspace={workspace} />
      </div>
    </main>
  );
}
