import Link from "next/link";
import { headers } from "next/headers";
import {
  addItem,
  deleteItem,
  finalizeParty,
  reopenParty,
  saveBudget,
  saveIntent,
  setItemShares,
  syncSilpoBasket,
  updateItem,
} from "@/app/parties/actions";
import { CopyInvite } from "@/components/copy-invite";
import { PartyStages, ShoppingTabs } from "@/components/party-stages";
import { PendingButton } from "@/components/pending-button";
import {
  calculateSplit,
  formatMoney,
  getPartyWorkspace,
  lineTotalCents,
} from "@/lib/parties";
import { getConnectionStatus } from "@/lib/silpo/oauth";

export default async function PartyPage({ params }: PageProps<"/party/[code]">) {
  const { code } = await params;
  const { user, party, members, profiles, intents, items, shares } =
    await getPartyWorkspace(code);
  const isHost = party.host_id === user.id;
  const isOpen = party.status === "collecting";
  const totalCents = items.reduce(
    (sum, item) => sum + lineTotalCents(item),
    0,
  );
  const split = calculateSplit(members, items, shares);
  const budgetPercent = party.budget_cents
    ? Math.min(100, Math.round((totalCents / party.budget_cents) * 100))
    : 0;
  const requestHeaders = await headers();
  const host =
    requestHeaders.get("x-forwarded-host") ??
    requestHeaders.get("host") ??
    "localhost:3000";
  const protocol =
    requestHeaders.get("x-forwarded-proto") ??
    (host.startsWith("localhost") ? "http" : "https");
  const origin =
    process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ??
    `${protocol}://${host}`;
  const inviteUrl = `${origin}/join/${party.code}`;
  const hostConnected = Boolean(
    await getConnectionStatus(party.host_id).catch(() => null),
  );
  const checkoutUrl = party.silpo_checkout_url?.startsWith("https://")
    ? party.silpo_checkout_url
    : null;
  const ownIntent = intents.find((intent) => intent.user_id === user.id);

  const guestsStage = (
    <div className="stage-stack">
      <header className="stage-heading">
        <span>Етап 1 з 4</span>
        <h2>Хто буде за столом?</h2>
        <p>Запрошуйте гостей зараз — до цього етапу можна повернутися.</p>
      </header>

      <div className="invite-panel">
        <div>
          <strong>Посилання-запрошення</strong>
          <p>{inviteUrl}</p>
        </div>
        <CopyInvite url={inviteUrl} />
      </div>

      <section className="guest-list" aria-label="Учасники події">
        {members.map((member, index) => {
          const hasIntent = intents.some(
            (intent) => intent.user_id === member.user_id,
          );
          return (
            <article className="guest-row" key={member.user_id}>
              <span className="guest-index">{index + 1}</span>
              <div>
                <strong>{member.display_name}</strong>
                <small>
                  {member.role === "host" ? "Організатор" : "Учасник"}
                </small>
              </div>
              <span className={hasIntent ? "readiness ready" : "readiness"}>
                {hasIntent ? "Вибір готовий" : "Ще обирає"}
              </span>
            </article>
          );
        })}
      </section>
    </div>
  );

  const preferencesStage = (
    <div className="stage-stack">
      <header className="stage-heading">
        <span>Етап 2 з 4</span>
        <h2>Що хочемо на вечерю?</h2>
        <p>
          Побажання та обмеження видно всій компанії. Їх можна змінювати,
          поки подія відкрита.
        </p>
      </header>

      <div className="intent-grid">
        {members.map((member) => {
          const intent = intents.find(
            (entry) => entry.user_id === member.user_id,
          );
          const profile = profiles.find(
            (entry) => entry.id === member.user_id,
          );
          const context = [
            profile?.allergies && `Алергії: ${profile.allergies}`,
            profile?.dietary_restrictions &&
              `Обмеження: ${profile.dietary_restrictions}`,
            profile?.dislikes && `Не любить: ${profile.dislikes}`,
            profile?.preferences && `Вподобання: ${profile.preferences}`,
          ].filter((entry): entry is string => Boolean(entry));

          return (
            <article className="intent-card" key={member.user_id}>
              <strong>
                {member.display_name}
                {member.role === "host" ? " · Організатор" : ""}
              </strong>
              {context.length > 0 && (
                <ul className="food-context">
                  {context.map((entry) => (
                    <li key={entry}>{entry}</li>
                  ))}
                </ul>
              )}
              {!intent ? (
                <p className="muted">Ще не відповів(-ла)</p>
              ) : intent.indifferent ? (
                <p>Мені байдуже — врахуйте мої обмеження</p>
              ) : (
                <>
                  <p>
                    {intent.dish_name ||
                      intent.description ||
                      "Побажання додано"}
                  </p>
                  {intent.content_url && (
                    <a
                      href={intent.content_url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Посилання на рецепт ↗
                    </a>
                  )}
                </>
              )}
            </article>
          );
        })}
      </div>

      {isOpen && (
        <details className="editor" open={!ownIntent}>
          <summary>Мій вибір</summary>
          <form
            action={saveIntent.bind(null, party.code)}
            className="stack form-grid"
          >
            <label>
              Страва
              <input
                name="dish_name"
                defaultValue={ownIntent?.dish_name ?? ""}
                placeholder="Наприклад, паста"
              />
            </label>
            <label>
              Деталі
              <textarea
                name="description"
                defaultValue={ownIntent?.description ?? ""}
                placeholder="Опишіть побажання"
              />
            </label>
            <label>
              Посилання на рецепт
              <input
                name="content_url"
                type="url"
                defaultValue={ownIntent?.content_url ?? ""}
                placeholder="https://…"
              />
            </label>
            <label className="check-row">
              <input
                name="indifferent"
                type="checkbox"
                defaultChecked={ownIntent?.indifferent}
              />
              Мені байдуже
            </label>
            <PendingButton
              className="primary-button"
              pendingLabel="Зберігаємо…"
            >
              Зберегти побажання
            </PendingButton>
          </form>
        </details>
      )}
    </div>
  );

  const basket = (
    <div className="stage-stack compact-stack">
      {isOpen && hostConnected && (
        <form
          action={addItem.bind(null, party.code)}
          className="add-item-form"
        >
          <label>
            Пошук у «Сільпо»
            <input
              name="name"
              required
              placeholder="Наприклад, Молоко Галичина 3,2%"
            />
          </label>
          <label>
            Кількість
            <input
              name="quantity"
              type="number"
              min="0.01"
              max="10000"
              step="0.01"
              defaultValue="1"
              required
            />
          </label>
          <PendingButton
            className="primary-button"
            pendingLabel="Шукаємо…"
          >
            Знайти й додати
          </PendingButton>
        </form>
      )}
      {isOpen && !hostConnected && (
        <p className="notice">
          Організатор має підключити «Сільпо», перш ніж учасники зможуть
          додавати реальні товари.
        </p>
      )}
      <div className="basket-list">
        {!items.length && (
          <p className="empty-state">
            Кошик порожній. Додайте перший товар.
          </p>
        )}
        {items.map((item) => {
          const updater = updateItem.bind(null, party.code, item.id);
          const remover = deleteItem.bind(null, party.code, item.id);
          return (
            <article className="basket-item" key={item.id}>
              <form action={updater} className="item-main">
                <div className="product-title">
                  <input
                    name="name"
                    defaultValue={item.name}
                    readOnly={!isOpen || Boolean(item.silpo_product_id)}
                    aria-label="Назва товару"
                  />
                  <small className={`sync-label ${item.silpo_sync_status}`}>
                    {item.silpo_sync_status === "synced"
                      ? "У реальному кошику ✓"
                      : item.silpo_sync_status === "error"
                        ? "Не синхронізовано"
                        : "Синхронізація…"}
                  </small>
                </div>
                <div className="item-numbers">
                  <input
                    name="quantity"
                    type="number"
                    min="0.01"
                    step="0.01"
                    defaultValue={item.quantity}
                    readOnly={!isOpen}
                    aria-label="Кількість"
                  />
                  <input value={item.unit} readOnly aria-label="Одиниця" />
                  <span>
                    {item.unit_price_cents
                      ? formatMoney(item.unit_price_cents)
                      : "Ціну визначить Сільпо"}
                  </span>
                  <strong>{formatMoney(lineTotalCents(item))}</strong>
                </div>
                {isOpen && (
                  <div className="item-actions">
                    <PendingButton
                      className="text-button"
                      pendingLabel="Оновлюємо…"
                    >
                      Оновити
                    </PendingButton>
                    <PendingButton
                      className="danger-button"
                      formAction={remover}
                      pendingLabel="Видаляємо…"
                    >
                      Видалити
                    </PendingButton>
                  </div>
                )}
              </form>
              {item.silpo_sync_error && (
                <p className="notice error">{item.silpo_sync_error}</p>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );

  const shoppingStage = (
    <div className="stage-stack">
      <header className="stage-heading">
        <span>Етап 3 з 4</span>
        <h2>Збираємо покупки</h2>
        <p>Контролюйте бюджет і синхронізацію з кошиком Організатора.</p>
      </header>

      <div className="dashboard-grid">
        <section className="panel budget-panel">
          <div className="section-row">
            <div>
              <p className="panel-label">Бюджет</p>
              <h3>
                {party.budget_cents
                  ? formatMoney(party.budget_cents)
                  : "Не встановлено"}
              </h3>
            </div>
            <strong
              className={
                totalCents > party.budget_cents && party.budget_cents
                  ? "over-budget"
                  : ""
              }
            >
              {formatMoney(totalCents)}
            </strong>
          </div>
          <div className="budget-track">
            <span
              className={
                totalCents > party.budget_cents && party.budget_cents
                  ? "danger"
                  : ""
              }
              style={{ width: `${budgetPercent}%` }}
            />
          </div>
          {isHost && isOpen && (
            <form
              action={saveBudget.bind(null, party.code)}
              className="inline-form"
            >
              <label>
                Бюджет, грн
                <input
                  name="budget"
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue={party.budget_cents / 100}
                  required
                />
              </label>
              <PendingButton
                className="secondary-button"
                pendingLabel="Зберігаємо…"
              >
                Зберегти
              </PendingButton>
            </form>
          )}
        </section>

        <section className="panel silpo-panel">
          <p className="panel-label">Кошик Організатора</p>
          <h3>{hostConnected ? "«Сільпо» підключено" : "Немає з’єднання"}</h3>
          {hostConnected ? (
            <div className="sync-row">
              <span className={`status-pill ${party.silpo_sync_status}`}>
                {party.silpo_sync_status === "synced"
                  ? "Синхронізовано"
                  : party.silpo_sync_status === "error"
                    ? "Помилка MCP"
                    : "Синхронізація…"}
              </span>
              {isHost && isOpen && (
                <form action={syncSilpoBasket.bind(null, party.code)}>
                  <PendingButton
                    className="text-button"
                    pendingLabel="Синхронізуємо…"
                  >
                    Повторити
                  </PendingButton>
                </form>
              )}
              {checkoutUrl && (
                <a
                  className="secondary-button"
                  href={checkoutUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Відкрити «Сільпо» ↗
                </a>
              )}
            </div>
          ) : isHost ? (
            <Link className="secondary-button" href="/profile">
              Підключити у профілі
            </Link>
          ) : (
            <p className="muted">Підключення налаштовує Організатор.</p>
          )}
          {party.silpo_sync_error && (
            <p className="notice error">{party.silpo_sync_error}</p>
          )}
        </section>
      </div>

      <ShoppingTabs basket={basket} />
    </div>
  );

  const splitStage = (
    <div className="stage-stack">
      <header className="stage-heading">
        <span>Етап 4 з 4</span>
        <h2>Хто за що платить?</h2>
        <p>Позначте людей для кожного товару й перевірте підсумок.</p>
      </header>

      <section className="share-editor-list" aria-label="Розподіл товарів">
        {items.map((item) => {
          const itemShares = shares
            .filter((share) => share.item_id === item.id)
            .map((share) => share.user_id);
          const shareAction = setItemShares.bind(
            null,
            party.code,
            item.id,
          );
          return (
            <form action={shareAction} className="share-editor" key={item.id}>
              <div>
                <strong>{item.name}</strong>
                <small>{formatMoney(lineTotalCents(item))}</small>
              </div>
              <div className="owner-chips">
                {members.map((member) => (
                  <label
                    key={member.user_id}
                    className={
                      itemShares.includes(member.user_id) ? "selected" : ""
                    }
                  >
                    <input
                      name="owner_ids"
                      value={member.user_id}
                      type="checkbox"
                      defaultChecked={itemShares.includes(member.user_id)}
                      disabled={!isOpen}
                    />
                    {member.display_name}
                  </label>
                ))}
              </div>
              {isOpen && (
                <PendingButton
                  className="text-button"
                  pendingLabel="Зберігаємо…"
                >
                  Зберегти
                </PendingButton>
              )}
            </form>
          );
        })}
        {!items.length && (
          <p className="empty-state">
            Спочатку додайте товари на етапі «Покупки».
          </p>
        )}
      </section>

      <div className="split-list">
        {members.map((member) => {
          const amount = split.get(member.user_id) ?? 0;
          const ownedItems = items.filter(
            (item) =>
              shares.some(
                (share) =>
                  share.item_id === item.id &&
                  share.user_id === member.user_id,
              ) ||
              (!shares.some((share) => share.item_id === item.id) &&
                item.added_by === member.user_id),
          );
          return (
            <article key={member.user_id} className="split-card">
              <div>
                <strong>{member.display_name}</strong>
                <small>
                  {member.user_id === party.host_id
                    ? "Організатор · сплачує чек"
                    : "Повертає Організатору"}
                </small>
              </div>
              <div className="split-amount">{formatMoney(amount)}</div>
              <div className="member-bar">
                <span
                  style={{
                    width: `${totalCents ? Math.round((amount / totalCents) * 100) : 0}%`,
                  }}
                />
              </div>
              <p>
                {ownedItems.map((item) => item.name).join(" · ") ||
                  "Немає призначених товарів"}
              </p>
            </article>
          );
        })}
      </div>

      <div className="final-row">
        <div>
          <strong>Загальний чек</strong>
          <span>{formatMoney(totalCents)}</span>
        </div>
        {isHost &&
          (isOpen ? (
            <form action={finalizeParty.bind(null, party.code)}>
              <PendingButton
                className="primary-button"
                disabled={!party.budget_cents || !items.length}
                pendingLabel="Фіналізуємо…"
              >
                Фіналізувати кошик
              </PendingButton>
            </form>
          ) : (
            <form action={reopenParty.bind(null, party.code)}>
              <PendingButton
                className="secondary-button"
                pendingLabel="Відкриваємо…"
              >
                Повернути до редагування
              </PendingButton>
            </form>
          ))}
      </div>
    </div>
  );

  return (
    <main className="page-shell align-start party-page">
      <div className="workspace party-workspace">
        <nav className="topbar">
          <Link href="/parties">← Усі події</Link>
          <Link href="/profile">Профіль</Link>
        </nav>
        <header className="party-hero compact-hero">
          <div>
            <p className="event-kicker">
              {isHost ? "Ви — Організатор" : "Ви — учасник"}
            </p>
            <h1>{party.title}</h1>
            <p className="muted">
              Код {party.code} · {members.length}/10 гостей
            </p>
          </div>
          <span className={`status-pill ${party.status}`}>
            {isOpen ? "Подія відкрита" : "Фіналізовано"}
          </span>
        </header>

        <PartyStages
          guests={guestsStage}
          preferences={preferencesStage}
          shopping={shoppingStage}
          split={splitStage}
        />
      </div>
    </main>
  );
}
