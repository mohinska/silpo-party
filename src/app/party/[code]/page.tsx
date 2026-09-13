import Link from "next/link";
import { headers } from "next/headers";
import { approveAgentV2Draft, confirmAiProposal, finalizeParty, reconcileAgentV2Cart, rejectAiProposal, reopenParty, runAiMealPlanner, saveBudget, saveIntent, sendPartyAgentMessage, sendPartyToSilpo } from "@/app/parties/actions";
import { CopyInvite } from "@/components/copy-invite";
import { AppHeader } from "@/components/app-header";
import { PartyWorkspaceShell } from "@/components/party-workspace-shell";
import { PendingButton } from "@/components/pending-button";
import { getPartyWorkspaceState } from "@/components/party-workspace-state";
import { formatMoney, getPartyWorkspace, lineTotalCents } from "@/lib/parties";
import { getConnectionStatus } from "@/lib/silpo/oauth";
import { latestMealProposal } from "@/lib/ai/planning/proposals";
import { createPlanningFingerprint, isCurrentMealProposal } from "@/lib/ai/planning/proposal-state";
import { latestActiveAgentRun } from "@/lib/ai/agents/agent-runs";
import { groupProposalWarnings } from "@/lib/ai/planning/proposal-ui";
import { agentV2Enabled } from "@/lib/ai/agents/agent-version";
import { loadAgentV2Presentation } from "@/lib/ai/agent-v2/presentation";

const blockerLabels: Record<string, string> = {
  empty: "Чернетка ще порожня.", missing: "Не всі інгредієнти або товари підібрані.",
  unknown: "Бракує перевірених даних про склад.", unsafe: "Знайдено конфлікт з обмеженнями учасника.",
  units: "Не вдалося безпечно узгодити одиниці виміру.", unavailable: "Потрібного товару зараз немає.",
  budget: "Поточна чернетка перевищує бюджет.",
};

export default async function PartyPage({ params }: PageProps<"/party/[code]">) {
  const { code } = await params;
  const workspace = await getPartyWorkspace(code);
  const { user, party, members, intents, items, messages } = workspace;
  const v2 = agentV2Enabled();
  const agentV2 = v2 ? await loadAgentV2Presentation({ partyId: party.id, actorId: user.id }) : null;
  const storedProposal = v2 ? null : await latestMealProposal(party.id);
  const proposal = storedProposal && isCurrentMealProposal(storedProposal, createPlanningFingerprint(workspace)) ? storedProposal : null;
  const activeAgentRun = v2 ? null : await latestActiveAgentRun(party.id);
  const isHost = party.host_id === user.id;
  const isOpen = party.status === "collecting";
  const hostConnected = Boolean(await getConnectionStatus(party.host_id).catch(() => null));
  const totalCents = agentV2?.draft?.totalCents ?? items.reduce((sum, item) => sum + lineTotalCents(item), 0);
  const workspaceState = getPartyWorkspaceState({ partyStatus: party.status, isHost, memberCount: members.length, intentCount: intents.length, itemCount: items.length, budgetCents: party.budget_cents, proposalStatus: proposal?.status ?? null, syncStatus: party.silpo_sync_status });
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const origin = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? `${protocol}://${host}`;
  const inviteUrl = `${origin}/join/${party.code}`;
  const currentIntent = intents.find((intent) => intent.user_id === user.id);
  const pendingPrivateQuestion = messages.findLast((message) => message.role === "assistant" && message.recipient_id === user.id && message.status === "waiting_for_input");
  const proposalWorking = v2
    ? ["queued", "working", "draft_updated", "cart_approved", "cart_applying"].includes(agentV2?.activity?.code ?? "")
    : proposal?.status === "applying" || Boolean(activeAgentRun);
  const draftLines = agentV2?.draft?.lines ?? [];
  const shownItemCount = v2 ? draftLines.length : items.length;

  const details = (
    <>
      <section className="readiness-section" aria-labelledby="readiness-title">
        <div className="section-heading-row"><div><p className="section-kicker">Учасники</p><h2 id="readiness-title">Побажання групи</h2></div><span className="readiness-count">{intents.length} з {members.length} готові</span></div>
        <div className="participant-list">{members.map((member) => { const intent = intents.find((entry) => entry.user_id === member.user_id); return <div className="participant-row" key={member.user_id}><span className="avatar" aria-hidden="true">{member.display_name.slice(0, 1).toUpperCase()}</span><span className="participant-copy"><strong>{member.display_name}{member.role === "host" ? " · Організатор" : ""}</strong><small>{intent ? (intent.content_url ? "Рецепт додано" : intent.dish_name || "Побажання додано") : "Очікує побажання"}</small></span><span className={`readiness-state${intent ? " ready" : ""}`}>{intent ? "Готово" : "Очікує"}</span></div>; })}</div>
      </section>
      {proposal?.dishes.length ? <section className="meal-plan-section" aria-labelledby="meal-plan-title"><div className="section-heading-row"><div><p className="section-kicker">План страв</p><h2 id="meal-plan-title">Що готуємо</h2></div><span className="quiet-meta">{proposal.dishes.length} {proposal.dishes.length === 1 ? "страва" : "страви"}</span></div><div className="dish-list">{proposal.dishes.map((dish) => <div className="dish-row" key={dish.id}><div><strong>{dish.name}</strong><small>{dish.servings} порц. · {dish.eaterParticipantIds.map((id) => members.find((member) => member.user_id === id)?.display_name ?? "Учасник").join(", ")}</small></div></div>)}</div></section> : null}
    </>
  );

  const basket = (
    <section className="basket-section" aria-labelledby="basket-title">
      <div className="basket-heading"><div><p className="section-kicker">Спільний результат</p><h2 id="basket-title">{v2 ? "Чернетка кошика" : "Кошик"}</h2></div><span className={`workspace-status ${agentV2?.ready || (!v2 && isOpen) ? "open" : "frozen"}`}>{v2 ? agentV2?.ready ? `Готова · v${agentV2.draft?.draftRevision}` : agentV2?.stale ? "Застаріла" : proposalWorking ? "Оновлюється" : "Не готова" : isOpen ? "Можна змінювати" : "Заморожено"}</span></div>
      <div className="basket-summary"><div><span>Разом</span><strong>{formatMoney(totalCents)}</strong></div><div><span>Бюджет</span><strong>{party.budget_cents === null ? "Не встановлено" : formatMoney(party.budget_cents)}</strong></div>{party.budget_cents !== null && <div><span>Залишок</span><strong className={totalCents > party.budget_cents ? "text-danger" : ""}>{formatMoney(party.budget_cents - totalCents)}</strong></div>}</div>
      {isHost && isOpen && <form action={saveBudget.bind(null, party.code)} className="budget-form"><label htmlFor="budget">Спільний бюджет <span className="optional-label">необов’язково</span></label><div className="input-action"><input id="budget" name="budget" type="number" min="0" step="0.01" defaultValue={party.budget_cents === null ? "" : party.budget_cents / 100} placeholder="Без обмеження" /><PendingButton className="secondary-button" pendingLabel="Зберігаємо…">Зберегти</PendingButton></div></form>}
      {!hostConnected && <p className="notice">Щоб відправити реальні товари, Організатору потрібно підключити «Сільпо» у профілі.</p>}
      {proposalWorking ? <div className="working-state"><div className="working-lines" aria-hidden="true"><span /><span /><span /></div><div><strong>Агент будує спільний кошик</strong><p>Поєднує побажання, обмеження та доступні товари.</p></div></div> : !shownItemCount ? <div className="empty-state"><strong>Кошик ще порожній</strong><p>{v2 ? "Додайте побажання в чаті — агент почне працювати одразу." : "Зберіть побажання групи, а потім запустіть побудову кошика."}</p></div> : v2 ? <div className="basket-list">{draftLines.map((line) => <article className="basket-item" key={`${line.productId}:${line.companyId}:${line.branchId}`}><div className="basket-item-copy"><div><strong>{line.name}</strong><small>{line.packageCount} уп. × {line.packageQuantity} {line.packageUnit} · {formatMoney(line.unitPriceCents)} за упаковку</small></div></div><strong>{formatMoney(line.lineTotalCents)}</strong></article>)}</div> : <div className="basket-list">{items.map((item) => <article className="basket-item" key={item.id}><div className="basket-item-copy"><div><strong>{item.name}</strong><small>{item.quantity} {item.unit} · {formatMoney(item.unit_price_cents)} за одиницю</small></div></div><strong>{formatMoney(lineTotalCents(item))}</strong></article>)}</div>}
      {v2 ? agentV2?.draft?.blockerCodes.map((code) => <p className="notice error" key={code}>{blockerLabels[code] ?? "Чернетка потребує перевірки агента."}</p>) : groupProposalWarnings(proposal?.unresolved ?? []).map((item) => <p className="notice error" key={item.reason}>{item.reason}{item.count > 1 ? ` · ${item.count} вимоги` : ""}</p>)}{!v2 && proposal?.error && <p className="notice error">{proposal.error}</p>}
      {v2 && agentV2?.operationStatus === "verified" && <p className="notice success">Версію v{agentV2.appliedRevision} перевірено та застосовано до кошика «Сільпо».</p>}
      {v2 && ["failed", "unknown"].includes(agentV2?.operationStatus ?? "") && <p className="notice error">Застосування до «Сільпо» не підтверджене. Не повторюйте запис до безпечної звірки.</p>}
      {v2 && ["blocked", "failed"].includes(agentV2?.activity?.code ?? "") && <p className="notice error">Агент зупинився на перевірці або залежності. Чернетка не може бути підтверджена, доки проблему не виправлено.</p>}
      {!v2 && isHost && isOpen && proposal && ["pending", "failed"].includes(proposal.status) && <div className="proposal-actions"><form action={runAiMealPlanner.bind(null, party.code)}><PendingButton className="secondary-button" pendingLabel="Повторюємо…">Повторити побудову</PendingButton></form><form action={rejectAiProposal.bind(null, party.code, proposal.id)}><PendingButton className="text-button" pendingLabel="Відхиляємо…">Відхилити</PendingButton></form></div>}
      {!v2 && isHost && isOpen && proposal?.status === "pending" && <form action={confirmAiProposal.bind(null, party.code, proposal.id)}><PendingButton className="secondary-button" disabled={proposal.unresolved.length > 0 || !proposal.productLines.length || !hostConnected} pendingLabel="Застосовуємо…">Додати товари до кошика</PendingButton></form>}
    </section>
  );

  const chatAction = currentIntent ? sendPartyAgentMessage.bind(null, party.code) : saveIntent.bind(null, party.code);
  const chatField = currentIntent ? "content" : "intent";
  const chat = (<section className="chat-content" aria-label="Чат з агентом"><div className="conversation" role="log" aria-live="polite" aria-label="Повідомлення чату">{!messages.length && <p className="empty-state"><strong>{currentIntent ? "Поки тихо" : "Почніть із побажання"}</strong><span>{currentIntent ? "Попросіть агента додати, прибрати або замінити товар." : "Напишіть страву, побажання або посилання на рецепт."}</span></p>}{messages.map((message) => { const member = members.find((entry) => entry.user_id === message.participant_id); return <article className={`chat-message ${message.role === "assistant" ? "assistant" : ""}`} key={message.id}><strong>{message.role === "assistant" ? "Агент" : member?.display_name ?? "Учасник"}</strong><p>{message.content}</p></article>; })}</div>{isOpen ? <form action={chatAction} className="composer">{pendingPrivateQuestion && currentIntent ? <input type="hidden" name="replyToMessageId" value={pendingPrivateQuestion.id} /> : null}<label htmlFor="party-agent-message">{pendingPrivateQuestion ? "Ваша приватна відповідь" : currentIntent ? "Що змінити в кошику?" : "Ваше побажання"}</label><textarea id="party-agent-message" name={chatField} maxLength={2_000} rows={3} placeholder={pendingPrivateQuestion ? "Відповідь бачить лише агент" : currentIntent ? "Наприклад: додайте напій без цукру" : "Наприклад: паста на чотирьох, без грибів"} required /><div className="composer-bottom"><span>{pendingPrivateQuestion ? "Відповідь прив’язана до цього питання й не показується іншим учасникам." : currentIntent ? "Агент змінює спільний кошик для всіх." : "Побажання одразу з’явиться у спільному плані."}</span><PendingButton className="primary-button" pendingLabel={currentIntent ? "Агент працює…" : "Зберігаємо…"}>{currentIntent ? "Надіслати" : "Додати побажання"}</PendingButton></div></form> : <p className="notice">Кошик заморожено. Історія чату доступна для перегляду.</p>}</section>);

  const actions = v2 ? (<div className="action-bar-inner">{isHost && agentV2?.operationId && ["applying", "unknown"].includes(agentV2.operationStatus ?? "") && <form action={reconcileAgentV2Cart.bind(null, party.code, agentV2.operationId)}><PendingButton className="primary-button" pendingLabel="Звіряємо…">Звірити стан кошика</PendingButton></form>}{isHost && isOpen && agentV2?.ready && agentV2.draft && agentV2.appliedRevision !== agentV2.draft.draftRevision && <form action={approveAgentV2Draft.bind(null, party.code, agentV2.draft.draftRevision)}><PendingButton className="primary-button" disabled={!hostConnected} pendingLabel="Перевіряємо й застосовуємо…">Підтвердити v{agentV2.draft.draftRevision} у «Сільпо»</PendingButton></form>}{isHost && isOpen && !agentV2?.ready && !["applying", "unknown"].includes(agentV2?.operationStatus ?? "") && <p className="action-explanation">{proposalWorking ? "Агент обробляє останні зміни." : "Підтвердження стане доступним після детермінованої перевірки чернетки."}</p>}{!isHost && <p className="action-explanation">Лише Організатор може підтвердити точну готову версію.</p>}</div>) : (<div className="action-bar-inner">{isHost && isOpen && workspaceState.build.enabled && (!proposal || proposal.status === "failed" || proposal.status === "rejected") && <form action={runAiMealPlanner.bind(null, party.code)}><PendingButton className="primary-button" pendingLabel="Будуємо кошик…">Побудувати кошик</PendingButton></form>}{isHost && isOpen && !workspaceState.build.enabled && !items.length && <p className="action-explanation">{workspaceState.build.reason}</p>}{isHost && isOpen && items.length > 0 && <form action={finalizeParty.bind(null, party.code)}>{items.map((item) => <input type="hidden" name={`owner_ids:${item.id}`} value={user.id} key={item.id} />)}<PendingButton className="primary-button" pendingLabel="Заморожуємо…">Фіналізувати кошик</PendingButton></form>}{!isHost && isOpen && <p className="action-explanation">Організатор фіналізує спільний кошик.</p>}{isHost && !isOpen && <><form action={sendPartyToSilpo.bind(null, party.code)}><PendingButton className="primary-button" pendingLabel="Відправляємо…">{party.silpo_sync_status === "error" ? "Спробувати ще раз" : "Відправити до «Сільпо»"}</PendingButton></form><form action={reopenParty.bind(null, party.code)}><PendingButton className="text-button" pendingLabel="Повертаємо…">Повернутися до редагування</PendingButton></form></>}{!isOpen && party.silpo_sync_status === "synced" && <p className="send-success" role="status">Кошик відправлено до «Сільпо».</p>}</div>);

  const debug = <><p><strong>Агент:</strong> {v2 ? agentV2?.activity?.code ?? "не запускався" : proposalWorking ? "працює" : proposal ? proposal.status : "не запускався"}</p><p><strong>Учасники:</strong> {intents.length}/{members.length} побажань</p><p><strong>Контекст «Сільпо»:</strong> {hostConnected ? "доступний для Організатора" : "не підключений"}</p><p><strong>Версія:</strong> {agentV2?.draft ? `v${agentV2.draft.draftRevision}` : "—"}</p></>;
  const liveStatus = v2 ? agentV2?.activity?.code.replaceAll("_", " ") : activeAgentRun?.progress_message;
  return <main className="party-page"><div className="party-container"><AppHeader user={user} backHref="/parties" /><header className="party-header"><Link className="back-link" href="/parties">← Події</Link><div className="party-header-main"><div><p className="section-kicker">{isHost ? "Ви — Організатор" : "Ви — учасник"}</p><h1>{party.title}</h1><p className="party-meta">{members.length}/10 учасників · код {party.code}</p></div><CopyInvite url={inviteUrl} /></div><div className="party-status-line"><span className={`workspace-status ${isOpen ? "open" : "frozen"}`}>{isOpen ? "Відкрита для змін" : "Фінальний перегляд"}</span>{proposalWorking && <span className="agent-status" role="status"><span className="status-dot" />Агент працює</span>}</div></header><PartyWorkspaceShell partyId={party.id} agentStatus={liveStatus} basket={basket} details={details} chat={chat} actions={actions} debug={debug} /></div></main>;
}
