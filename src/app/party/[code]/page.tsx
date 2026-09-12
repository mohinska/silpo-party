import Link from "next/link";
import { headers } from "next/headers";
import { confirmAiProposal, saveBudget, sendPartyAgentMessage } from "@/app/parties/actions";
import { CopyInvite } from "@/components/copy-invite";
import { PartyTabs } from "@/components/party-tabs";
import { PendingButton } from "@/components/pending-button";
import { formatMoney, getPartyWorkspace, lineTotalCents } from "@/lib/parties";
import { getConnectionStatus } from "@/lib/silpo/oauth";
import { latestMealProposal } from "@/lib/ai/planning/proposals";

export default async function PartyPage({ params }: PageProps<"/party/[code]">) {
  const { code } = await params;
  const { user, party, members, intents, items, messages } = await getPartyWorkspace(code);
  const proposal = await latestMealProposal(party.id);
  const isHost = party.host_id === user.id;
  const isOpen = party.status === "collecting";
  const hostConnected = Boolean(await getConnectionStatus(party.host_id).catch(() => null));
  const totalCents = items.reduce((sum, item) => sum + lineTotalCents(item), 0);
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const origin = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? `${protocol}://${host}`;
  const inviteUrl = `${origin}/join/${party.code}`;

  const chat = (
    <section className="stage-stack agent-chat" aria-label="Чат з агентом">
      <header className="stage-heading"><span>Спільний чат</span><h2>Що сьогодні їмо?</h2><p>Пишіть звичайними словами. Агент врахує всіх учасників, бюджет і обмеження та сам оновить кошик.</p></header>
      <div className="conversation" role="log" aria-label="Побажання учасників">
        {!messages.length && !intents.length && <p className="empty-state">Поки немає побажань. Почніть із повідомлення нижче.</p>}
        {!messages.length && intents.map((intent) => {
          const member = members.find((entry) => entry.user_id === intent.user_id);
          return <article className="intent-card" key={intent.user_id}><strong>{member?.display_name ?? "Учасник"}</strong><p>{intent.indifferent ? "Мені байдуже — врахуйте мої обмеження." : [intent.dish_name, intent.description].filter(Boolean).join(" — ") || "Побажання додано."}</p></article>;
        })}
        {messages.map((message) => {
          const member = members.find((entry) => entry.user_id === message.participant_id);
          return <article className={`intent-card ${message.role === "assistant" ? "assistant-message" : ""}`} key={message.id}><strong>{message.role === "assistant" ? "Агент" : member?.display_name ?? "Учасник"}</strong><p>{message.content}</p></article>;
        })}
        {proposal?.error && <p className="notice error">{proposal.error}</p>}
      </div>
      {isOpen ? <form action={sendPartyAgentMessage.bind(null, party.code)} className="composer"><label htmlFor="party-agent-message">Ваше повідомлення</label><textarea id="party-agent-message" name="content" maxLength={2_000} rows={3} placeholder="Наприклад: паста на чотирьох, без грибів, і щось попити" required /><div className="composer-bottom"><span>Агент оновлює спільний кошик для всіх.</span><PendingButton className="primary-button" pendingLabel="Агент працює…">Надіслати</PendingButton></div></form> : <p className="notice">Кошик підтверджено. Історія побажань доступна для перегляду.</p>}
    </section>
  );

  const basket = (
    <section className="stage-stack compact-stack" aria-label="Кошик події">
      <header className="stage-heading"><span>Результат роботи агента</span><h2>Спільний кошик</h2><p>Позиції додає та змінює агент. Перед відправленням Host підтверджує фінальний кошик.</p></header>
      <section className="panel budget-panel"><div className="section-row"><div><p className="panel-label">Бюджет</p><h3>{party.budget_cents ? formatMoney(party.budget_cents) : "Не встановлено"}</h3></div><strong>{formatMoney(totalCents)}</strong></div>{isHost && isOpen && <form action={saveBudget.bind(null, party.code)} className="inline-form"><label>Бюджет, грн<input name="budget" type="number" min="0" step="0.01" defaultValue={party.budget_cents / 100} required /></label><PendingButton className="secondary-button" pendingLabel="Зберігаємо…">Зберегти</PendingButton></form>}</section>
      {!hostConnected && <p className="notice">Host має підключити «Сільпо» у профілі, щоб агент міг підібрати й відправити реальні товари.</p>}
      {!items.length ? <p className="empty-state">Кошик порожній. Напишіть агенту в чаті.</p> : <div className="basket-list">{items.map((item) => <article className="basket-item" key={item.id}><div><strong>{item.name}</strong><small>{item.quantity} {item.unit} × {formatMoney(item.unit_price_cents)}</small></div><strong>{formatMoney(lineTotalCents(item))}</strong></article>)}</div>}
      <div className="total"><span>Разом</span><strong>{formatMoney(totalCents)}</strong></div>
      {proposal && <section className="agent-proposal"><p className="proposal-status"><strong>{proposal.budgetStatus === "within" ? "У межах бюджету" : proposal.budgetStatus === "over" ? "Понад бюджет" : "Потрібне уточнення"}</strong></p>{proposal.unresolved.map((item) => <p className="notice error" key={item.requirementKey}>{item.reason}</p>)}</section>}
      {isHost && isOpen && proposal && <form action={confirmAiProposal.bind(null, party.code, proposal.id)}><PendingButton className="primary-button" disabled={proposal.budgetStatus !== "within" || proposal.unresolved.length > 0 || !items.length || !hostConnected} pendingLabel="Підтверджуємо…">Підтвердити й відправити до «Сільпо»</PendingButton></form>}
      {!isHost && <p className="muted">Фінальне підтвердження доступне Host’у.</p>}
    </section>
  );

  return <main className="page-shell align-start party-page"><div className="workspace party-workspace"><nav className="topbar"><Link href="/parties">← Усі події</Link><Link href="/profile">Профіль</Link></nav><header className="party-hero compact-hero"><div><p className="event-kicker">{isHost ? "Ви — Організатор" : "Ви — учасник"}</p><h1>{party.title}</h1><p className="muted">Код {party.code} · {members.length}/10 гостей</p></div><span className={`status-pill ${party.status}`}>{isOpen ? "Подія відкрита" : "Підтверджено"}</span></header><section className="invite-panel"><div><strong>Запросити учасників</strong><p>{inviteUrl}</p></div><CopyInvite url={inviteUrl} /></section><section className="guest-list" aria-label="Учасники події">{members.map((member) => <article className="guest-row" key={member.user_id}><div><strong>{member.display_name}</strong><small>{member.role === "host" ? "Організатор" : "Учасник"}</small></div><span className="readiness ready">{intents.some((intent) => intent.user_id === member.user_id) ? "Контекст додано" : "Очікує побажання"}</span></article>)}</section><PartyTabs chat={chat} basket={basket} /></div></main>;
}
