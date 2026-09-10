"use client";

import { useActionState, useEffect, useOptimistic, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { DebugPartyWorkspace } from "@/lib/ai/debug-party/repository";
import { sendDebugMessage } from "../../actions";
import type { WorkspaceUi } from "./workspace-client";
import { participantName } from "./participant-name";
import styles from "../../page.module.css";

const examples = ["Пасту на чотирьох", "Снеки та напої", "Заміни на дешевше"];

export function ChatPanel({ workspace, ui }: { workspace: DebugPartyWorkspace; ui: WorkspaceUi }) {
  const [draft, setDraft] = useState("");
  const [optimistic, setOptimistic] = useOptimistic<{ content: string; knownIds: string[] } | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const router = useRouter();
  const messages = workspace.chatMessages ?? [];
  const [error, action, pending] = useActionState(async (_previous: string, data: FormData) => {
    const content = String(data.get("content") ?? "").trim();
    if (!content) return "Напишіть, чого хочеться.";
    setOptimistic({ content, knownIds: messages.map((message) => message.id) });
    try {
      const result = await sendDebugMessage(data);
      if (result.status === "failed") return "Помічник не завершив запит. Його можна повторити нижче.";
      setDraft("");
      return "";
    } catch { return "Не вдалося завершити запит. Перевірте підключення та повторіть спробу."; }
    finally { router.refresh(); }
  }, "");
  const showOptimistic = optimistic && !messages.some((message) => !optimistic.knownIds.includes(message.id) && message.participantId === workspace.member.participantId && message.content === optimistic.content);

  useEffect(() => { end.current?.scrollIntoView({ block: "nearest" }); }, [messages.length, pending]);

  return <section id="party-chat" className={styles.chatPanel} aria-label="Спільний чат">
    <div className={styles.panelHeading}><h2>Що сьогодні їмо?</h2><span>{workspace.members.length} у компанії</span></div>
    <div className={styles.conversation} role="log" aria-label="Повідомлення вечірки" aria-live="polite">
      {messages.length === 0 && <div className={styles.chatWelcome}>
        <span className={styles.assistantMark} aria-hidden="true">с</span>
        <h3>Почнімо з того, чого хочеться.</h3>
        <p>Страва, перекус чи посилання на рецепт — напишіть своїми словами. Я підберу продукти для вашої компанії.</p>
        <p className={styles.muted}>Наприклад: «Піца на чотирьох, без грибів. І щось попити».</p>
      </div>}
      {messages.map((message) => <article key={message.id} className={message.role === "assistant" ? styles.assistantMessage : styles.userMessage}>
        <div className={styles.messageMeta}><strong>{participantName(workspace, message.participantId)}</strong><time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Kyiv" })}</time></div>
        <p>{message.content}</p>
        {message.role === "user" && message.status !== "completed" && <small>{message.status === "failed" ? "Запит не завершено" : message.status === "queued" ? "У черзі" : "Помічник опрацьовує"}</small>}
        {message.status === "failed" && message.participantId === workspace.member.participantId && !ui.frozen && <button className={styles.textButton} type="button" disabled={pending || ui.chatDisabled} onClick={() => { setDraft(message.content); input.current?.focus(); }}>Повторити запит</button>}
      </article>)}
      {showOptimistic && <article className={`${styles.userMessage} ${styles.optimistic}`}><div className={styles.messageMeta}><strong>Ви</strong><span>Надсилаємо…</span></div><p>{optimistic.content}</p></article>}
      {(pending || ui.busy) && <p className={styles.thinking} role="status"><span aria-hidden="true" />{workspace.member.contextStatus === "running" ? "Готуємо ваш контекст Сільпо…" : "Помічник працює над кошиком…"}</p>}
      <div ref={end} />
    </div>
    {ui.frozen ? <div className={styles.closedComposer}>Кошик фіналізовано. Історія розмови доступна для перегляду.</div> :
      <form action={action} className={styles.composer}>
        <input type="hidden" name="code" value={workspace.party.code} />
        <div className={styles.examples}>{examples.map((example) => <button key={example} type="button" disabled={pending || ui.chatDisabled} onClick={() => { setDraft(example); input.current?.focus(); }}>{example}</button>)}</div>
        <label htmlFor="party-message">Ваше повідомлення</label>
        <textarea ref={input} id="party-message" name="content" value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={2000} required rows={2} disabled={pending || ui.chatDisabled} placeholder="Додай, прибери, заміни… або встав посилання на рецепт" />
        {error && <p role="alert" className={styles.error}>{error}</p>}
        <div className={styles.composerBottom}><span>Спільний чат. Кошик оновлюється для всіх.</span><button type="submit" className={styles.primaryButton} disabled={pending || ui.chatDisabled || !draft.trim()}>{pending ? "Надсилаємо…" : error ? "Повторити" : "Надіслати"}</button></div>
      </form>}
  </section>;
}
