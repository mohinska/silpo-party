import Link from "next/link";
import { headers } from "next/headers";
import { CopyInvite } from "@/components/copy-invite";
import { calculateSplit, formatMoney, getPartyWorkspace, lineTotalCents } from "@/lib/parties";
import { getConnectionStatus } from "@/lib/silpo/oauth";
import { addItem, deleteItem, finalizeParty, reopenParty, saveBudget, saveIntent, setItemShares, syncSilpoBasket, updateItem } from "@/app/parties/actions";

export default async function PartyPage({ params }: PageProps<"/party/[code]">) {
  const { code } = await params;
  const { user, party, members, profiles, intents, items, shares } = await getPartyWorkspace(code);
  const isHost = party.host_id === user.id;
  const isOpen = party.status === "collecting";
  const totalCents = items.reduce((sum, item) => sum + lineTotalCents(item), 0);
  const split = calculateSplit(members, items, shares);
  const budgetPercent = party.budget_cents ? Math.min(100, Math.round(totalCents / party.budget_cents * 100)) : 0;
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const origin = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? `${protocol}://${host}`;
  const inviteUrl = `${origin}/join/${party.code}`;
  const hostConnected = Boolean(await getConnectionStatus(party.host_id).catch(() => null));
  const checkoutUrl = party.silpo_checkout_url?.startsWith("https://") ? party.silpo_checkout_url : null;
  const ownIntent = intents.find((intent) => intent.user_id === user.id);

  return (
    <main className="page-shell align-start">
      <div className="workspace">
        <nav className="topbar"><Link href="/parties">← Усі події</Link><Link href="/profile">Профіль</Link></nav>
        <header className="party-hero">
          <div><p className="eyebrow">{isHost ? "Ви — Організатор" : "Ви — учасник"}</p><h1>{party.title}</h1><p className="muted">Код: <strong>{party.code}</strong> · {members.length}/10 учасників</p></div>
          <span className={`status-pill ${party.status}`}>{isOpen ? "Збираємо кошик" : "Фіналізовано"}</span>
        </header>

        <section className="invite-panel">
          <div><strong>Запросіть інших</strong><p>{inviteUrl}</p></div><CopyInvite url={inviteUrl} />
        </section>

        <div className="dashboard-grid">
          <section className="panel budget-panel">
            <div className="section-row"><div><p className="eyebrow">Спільний бюджет</p><h2>{party.budget_cents ? formatMoney(party.budget_cents) : "Не встановлено"}</h2></div><strong className={totalCents > party.budget_cents && party.budget_cents ? "over-budget" : ""}>{formatMoney(totalCents)}</strong></div>
            <div className="budget-track"><span className={totalCents > party.budget_cents && party.budget_cents ? "danger" : ""} style={{ width: `${budgetPercent}%` }} /></div>
            <p className="muted">У кошику {items.length} товарів · {party.budget_cents ? `${budgetPercent}% бюджету` : "Організатор має встановити бюджет"}</p>
            {isHost && isOpen && <form action={saveBudget.bind(null, party.code)} className="inline-form"><label>Бюджет, грн<input name="budget" type="number" min="0" step="0.01" defaultValue={party.budget_cents / 100} required /></label><button className="secondary-button">Зберегти</button></form>}
          </section>

          <section className="panel">
            <p className="eyebrow">«Сільпо»</p><h2>{hostConnected ? "Організатор підключений ✓" : "Потрібне підключення Організатора"}</h2>
            <p className="muted">Спільний кошик синхронізується з реальним кошиком «Сільпо» через захищену MCP-сесію Організатора. Іншим учасникам акаунт «Сільпо» не потрібен.</p>
            {isHost && !hostConnected && <Link className="secondary-button" href="/profile">Підключити у профілі</Link>}
            {hostConnected && <div className="sync-row"><span className={`status-pill ${party.silpo_sync_status}`}>{party.silpo_sync_status === "synced" ? "Синхронізовано" : party.silpo_sync_status === "error" ? "Помилка MCP" : "Синхронізація…"}</span>{isHost && isOpen && <form action={syncSilpoBasket.bind(null, party.code)}><button className="text-button">Повторити синхронізацію</button></form>}{checkoutUrl && <a className="secondary-button" href={checkoutUrl} target="_blank" rel="noreferrer">Відкрити кошик «Сільпо» ↗</a>}</div>}
            {party.silpo_sync_error && <p className="notice error">{party.silpo_sync_error}</p>}
          </section>
        </div>

        <section className="panel stack">
          <div className="section-row"><div><p className="eyebrow">Хто що хоче</p><h2>Наміри учасників</h2></div><span className="muted">{intents.length}/{members.length} відповіли</span></div>
          <div className="intent-grid">
            {members.map((member) => {
              const intent = intents.find((entry) => entry.user_id === member.user_id);
              const profile = profiles.find((entry) => entry.id === member.user_id);
              const context = [
                profile?.allergies && `Алергії: ${profile.allergies}`,
                profile?.dietary_restrictions && `Обмеження: ${profile.dietary_restrictions}`,
                profile?.dislikes && `Не любить: ${profile.dislikes}`,
                profile?.preferences && `Вподобання: ${profile.preferences}`,
              ].filter((entry): entry is string => Boolean(entry));
              return <article className="intent-card" key={member.user_id}><strong>{member.display_name}{member.role === "host" ? " · Організатор" : ""}</strong>{context.length > 0 && <ul className="food-context">{context.map((entry) => <li key={entry}>{entry}</li>)}</ul>}{!intent ? <p className="muted">Ще не відповів(-ла)</p> : intent.indifferent ? <p>Мені байдуже — врахуйте мої обмеження</p> : <><p>{intent.dish_name || intent.description || "Побажання додано"}</p>{intent.content_url && <a href={intent.content_url} target="_blank" rel="noreferrer">Посилання на рецепт ↗</a>}</>}</article>;
            })}
          </div>
          {isOpen && <details className="editor" open={!ownIntent}><summary>Моє побажання</summary><form action={saveIntent.bind(null, party.code)} className="stack form-grid"><label>Страва<input name="dish_name" defaultValue={ownIntent?.dish_name ?? ""} placeholder="Наприклад, паста" /></label><label>Що хочете їсти / деталі<textarea name="description" defaultValue={ownIntent?.description ?? ""} placeholder="Опишіть побажання" /></label><label>Посилання на рецепт<input name="content_url" type="url" defaultValue={ownIntent?.content_url ?? ""} placeholder="https://…" /></label><label className="check-row"><input name="indifferent" type="checkbox" defaultChecked={ownIntent?.indifferent} /> Мені байдуже</label><button className="primary-button">Зберегти побажання</button></form></details>}
        </section>

        <section className="panel stack">
          <div><p className="eyebrow">Спільний кошик</p><h2>Товари додають усі учасники</h2></div>
          {isOpen && hostConnected && <form action={addItem.bind(null, party.code)} className="add-item-form"><label>Пошук товару в «Сільпо»<input name="name" required placeholder="Наприклад, Молоко Галичина 3,2%" /></label><label>Кількість<input name="quantity" type="number" min="0.01" max="10000" step="0.01" defaultValue="1" required /></label><button className="primary-button">Знайти й додати</button></form>}
          {isOpen && !hostConnected && <p className="notice">Організатор має підключити «Сільпо», перш ніж учасники зможуть додавати реальні товари.</p>}
          <div className="basket-list">
            {!items.length && <p className="empty-state">Кошик порожній. Додайте перший товар.</p>}
            {items.map((item) => {
              const itemShares = shares.filter((share) => share.item_id === item.id).map((share) => share.user_id);
              const updater = updateItem.bind(null, party.code, item.id);
              const shareAction = setItemShares.bind(null, party.code, item.id);
              const remover = deleteItem.bind(null, party.code, item.id);
              return <article className="basket-item" key={item.id}>
                <form action={updater} className="item-main"><div className="product-title"><input name="name" defaultValue={item.name} readOnly={!isOpen || Boolean(item.silpo_product_id)} aria-label="Назва товару" /><small className={`sync-label ${item.silpo_sync_status}`}>{item.silpo_sync_status === "synced" ? "У реальному кошику ✓" : item.silpo_sync_status === "error" ? "Не синхронізовано" : "Синхронізація…"}</small></div><div className="item-numbers"><input name="quantity" type="number" min="0.01" step="0.01" defaultValue={item.quantity} readOnly={!isOpen} aria-label="Кількість" /><input value={item.unit} readOnly aria-label="Одиниця" /><span>{item.unit_price_cents ? formatMoney(item.unit_price_cents) : "Ціну визначить Сільпо"}</span><strong>{formatMoney(lineTotalCents(item))}</strong></div>{isOpen && <div className="item-actions"><button className="text-button">Оновити кількість</button><button className="danger-button" formAction={remover}>Видалити</button></div>}</form>
                {item.silpo_sync_error && <p className="notice error">{item.silpo_sync_error}</p>}
                <form action={shareAction} className="share-form"><span>Хто споживає / оплачує:</span><div className="owner-chips">{members.map((member) => <label key={member.user_id} className={itemShares.includes(member.user_id) ? "selected" : ""}><input name="owner_ids" value={member.user_id} type="checkbox" defaultChecked={itemShares.includes(member.user_id)} disabled={!isOpen} />{member.display_name}</label>)}</div>{isOpen && <button className="text-button">Зберегти розподіл</button>}</form>
              </article>;
            })}
          </div>
        </section>

        <section className="panel stack">
          <div><p className="eyebrow">Розрахунок</p><h2>Скільки кожен повертає Організатору</h2><p className="muted">Кожен товар ділиться порівну між позначеними людьми. Копійки розподіляються детерміновано, тому загальна сума завжди сходиться.</p></div>
          <div className="split-list">{members.map((member) => {
            const amount = split.get(member.user_id) ?? 0;
            const ownedItems = items.filter((item) => shares.some((share) => share.item_id === item.id && share.user_id === member.user_id) || (!shares.some((share) => share.item_id === item.id) && item.added_by === member.user_id));
            return <article key={member.user_id} className="split-card"><div><strong>{member.display_name}</strong><small>{member.user_id === party.host_id ? "Організатор · сплачує весь чек" : `Повертає Організатору`}</small></div><div className="split-amount">{formatMoney(amount)}</div><div className="member-bar"><span style={{ width: `${totalCents ? Math.round(amount / totalCents * 100) : 0}%` }} /></div><p>{ownedItems.map((item) => item.name).join(" · ") || "Немає призначених товарів"}</p></article>;
          })}</div>
          <div className="final-row"><div><strong>Загальний чек</strong><span>{formatMoney(totalCents)}</span></div>{isHost && (isOpen ? <form action={finalizeParty.bind(null, party.code)}><button className="primary-button" disabled={!party.budget_cents || !items.length}>Фіналізувати кошик</button></form> : <form action={reopenParty.bind(null, party.code)}><button className="secondary-button">Повернути до редагування</button></form>)}</div>
        </section>
      </div>
    </main>
  );
}
