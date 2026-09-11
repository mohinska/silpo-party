"use client";

import { useActionState } from "react";
import type { DebugPartyWorkspace } from "@/lib/ai/debug-party/repository";
import type { SendResult } from "@/lib/ai/debug-party/send-to-silpo";
import { deriveSendUi } from "@/lib/ai/debug-party/ui-state";
import { buildDebugBasket, clearDebugParty, finalizeDebugParty, saveDebugBudget, sendDebugCartToSilpo } from "../../actions";
import type { WorkspaceUi } from "./workspace-client";
import styles from "../../page.module.css";

export const money = (cents: number) => new Intl.NumberFormat("uk-UA", { style: "currency", currency: "UAH", maximumFractionDigits: 2 }).format(cents / 100);

function HostControls({ workspace, ui }: { workspace: DebugPartyWorkspace; ui: WorkspaceUi }) {
  const [result, action, pending] = useActionState(async (_previous: string, data: FormData) => {
    try {
      if (data.get("operation") === "finalize") { await finalizeDebugParty(data); return "Кошик фіналізовано."; }
      if (data.get("operation") === "clear") { await clearDebugParty(data); return "Вечірку очищено. Учасники можуть починати новий сценарій."; }
      const built = await buildDebugBasket(data);
      return built.status === "failed" ? "Не вдалося перебудувати кошик. Спробуйте ще раз." : "Кошик оновлено.";
    } catch { return "Дію не завершено. Оновіть сторінку та повторіть спробу."; }
  }, "");
  return <form action={action} className={styles.hostActions}>
    <input type="hidden" name="code" value={workspace.party.code} />
    <p>Керує організатор</p>
    <div><button name="operation" value="build" className={styles.secondaryButton} disabled={pending || ui.buildDisabled}>Перебудувати</button><button name="operation" value="finalize" className={styles.primaryButton} disabled={pending || ui.finalizeDisabled}>Фіналізувати</button></div>
    <button name="operation" value="clear" className={styles.secondaryButton} disabled={pending} onClick={(event) => { if (!window.confirm("Очистити чат, кошик і журнал для всіх учасників? Учасники та бюджет залишаться.")) event.preventDefault(); }}>Очистити вечірку</button>
    <small>Очищення прибирає чат, локальний кошик і журнал. Учасники та бюджет залишаються.</small>
    {(pending || result) && <p role="status">{pending ? "Оновлюємо кошик…" : result}</p>}
  </form>;
}

function Budget({ workspace, frozen }: { workspace: DebugPartyWorkspace; frozen: boolean }) {
  const [result, action, pending] = useActionState(async (_previous: string, data: FormData) => {
    try { await saveDebugBudget(data); return "Бюджет збережено."; }
    catch { return "Не вдалося зберегти бюджет. Вкажіть суму з точністю до копійки."; }
  }, "");
  if (workspace.member.role !== "host" || frozen) return null;
  return <details className={styles.budgetEditor}><summary>Бюджет · необов’язково</summary><form action={action}>
    <input type="hidden" name="code" value={workspace.party.code} />
    <label htmlFor="party-budget">Сума, грн<input key={workspace.party.budgetCents ?? "none"} id="party-budget" name="budget" type="number" min="0" step="0.01" defaultValue={workspace.party.budgetCents === null ? "" : workspace.party.budgetCents / 100} placeholder="Без обмеження" disabled={pending} /></label>
    <button className={styles.secondaryButton} disabled={pending}>{pending ? "Зберігаємо…" : "Зберегти"}</button>
    {result && <p role="status">{result}</p>}
  </form></details>;
}

function SendBasket({ workspace, ui }: { workspace: DebugPartyWorkspace; ui: WorkspaceUi }) {
  const [state, action, pending] = useActionState<{ result: SendResult | null; error: string }, FormData>(async (_previous, data) => {
    try { return { result: await sendDebugCartToSilpo(data), error: "" }; }
    catch { return { result: null, error: "Не вдалося надіслати кошик. Перевірте підключення Сільпо та повторіть." }; }
  }, { result: null, error: "" });
  const confirmation = state.result?.status === "confirmation_required";
  const status = state.error ? "failed" : state.result?.status ?? workspace.sendStatus ?? null;
  const send = deriveSendUi({ partyStatus: workspace.party.status, role: workspace.member.role, sendStatus: status, changesVisible: confirmation });
  const partial = status === "partial";
  const items = workspace.snapshot?.items ?? [];
  if (!ui.frozen) return null;
  return <div className={styles.sendPanel}>
    {send.sent ? <p className={styles.success} role="status">Надіслано до кошика Сільпо. Замовлення оформлюється в Сільпо.</p> : workspace.member.role !== "host" ? <p>Організатор може надіслати цей кошик до Сільпо.</p> : <form action={action}>
      <input type="hidden" name="code" value={workspace.party.code} />
      <input type="hidden" name="confirmChanges" value={send.confirmChanges ? "true" : "false"} />
      {status === "confirmation_required" && !confirmation && <p className={styles.warning}>Потрібно перевірити поточні ціни та наявність перед підтвердженням.</p>}
      {confirmation && <div className={styles.warning} role="status"><strong>Ціни або наявність змінилися</strong><ul>{state.result?.status === "confirmation_required" && state.result.changes.map((change) => <li key={change.itemId}>{items.find((item) => item.id === change.itemId)?.name ?? "Позиція кошика"}: {change.available ? money(change.unitPriceCents) : "немає в наявності — буде пропущено"}</li>)}</ul><p>Підтвердіть надсилання доступних товарів за поточними цінами.</p></div>}
      {partial && <p className={styles.warning} role="status">Частину позицій не вдалося надіслати. Повторіть надсилання, щоб завершити кошик.</p>}
      {state.error && <p className={styles.error} role="alert">{state.error}</p>}
      <button className={styles.primaryButton} disabled={pending || send.disabled || !workspace.snapshot}>{pending ? "Надсилаємо до Сільпо…" : send.label}</button>
      <small>Надсилаємо зафіксований кошик до акаунта організатора.</small>
    </form>}
  </div>;
}

export function BasketPanel({ workspace, ui }: { workspace: DebugPartyWorkspace; ui: WorkspaceUi }) {
  const items = ui.frozen ? workspace.snapshot?.items ?? [] : workspace.cartItems;
  const total = ui.frozen ? workspace.snapshot?.totalCents ?? 0 : items.reduce((sum, item) => sum + Math.round(item.unitPriceCents * item.quantity), 0);
  const budget = workspace.party.budgetCents;
  const remaining = budget === null ? null : budget - total;
  return <aside id="party-cart" className={styles.cartPanel} aria-label="Кошик вечірки">
    <div className={styles.receipt}>
      <div className={styles.receiptHeading}><span className={styles.receiptBrand}>Сільпо</span><span className={styles.revision}>Версія {workspace.snapshot?.cartRevision ?? workspace.party.cartRevision}</span></div>
      <h2>{ui.cartLabel}</h2><p className={styles.receiptSubtitle}>{ui.frozen ? "Зафіксовано для вашої компанії" : "Продукти з підтвердженою ціною"}</p>
      {workspace.cartStale && !ui.frozen && <p className={styles.warning}>Побажання змінилися. Попросіть помічника оновити кошик або перебудуйте його.</p>}
      {ui.frozen && !workspace.snapshot && <p role="alert" className={styles.error}>Фінальний кошик недоступний. Оновіть сторінку.</p>}
      {items.length ? <ul className={styles.receiptItems}>{items.map((item) => <li key={item.id}><div><strong>{item.name}</strong><span>{item.quantity} {item.unit} × {money(item.unitPriceCents)}</span></div><b>{money(Math.round(item.quantity * item.unitPriceCents))}</b></li>)}</ul> : <div className={styles.emptyCart}><span aria-hidden="true">＋</span><p>Тут з’являться продукти.<br />Почніть із повідомлення в чаті.</p></div>}
      <div className={styles.total}><span>Разом</span><strong>{money(total)}</strong></div>
      {remaining !== null && <div className={styles.budgetSummary}><div><span>Бюджет</span><span>{money(budget!)}</span></div><div className={remaining < 0 ? styles.overBudget : ""}><span>{remaining < 0 ? "Перевищення" : "Залишок"}</span><strong>{money(Math.abs(remaining))}</strong></div></div>}
      <Budget workspace={workspace} frozen={ui.frozen} />
      <p className={styles.receiptFoot}>{items.length} позицій · {workspace.members.length} учасників</p>
    </div>
    {workspace.member.role === "host" && !ui.frozen && <HostControls workspace={workspace} ui={ui} />}
    <SendBasket workspace={workspace} ui={ui} />
  </aside>;
}
