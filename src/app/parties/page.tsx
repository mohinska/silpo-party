import Link from "next/link";
import { PendingButton } from "@/components/pending-button";
import { formatMoney, listMyParties } from "@/lib/parties";
import { createParty, joinByCode } from "./actions";

export default async function PartiesPage() {
  const parties = await listMyParties();
  return (
    <main className="page-shell align-start">
      <div className="workspace narrow-workspace">
        <nav className="topbar"><Link href="/">Сільпо Party</Link><Link href="/profile">Профіль</Link></nav>
        <header className="section-heading"><p className="eyebrow">Події</p><h1>Спільні покупки починаються тут</h1><p className="muted">Створіть подію або приєднайтеся за посиланням чи кодом.</p></header>
        <div className="two-column">
          <form action={createParty} className="panel stack">
            <h2>Створити подію</h2>
            <label>Назва<input name="title" required maxLength={80} placeholder="Вечеря у суботу" /></label>
            <PendingButton className="primary-button" pendingLabel="Створюємо…">Створити як Організатор</PendingButton>
          </form>
          <form action={joinByCode} className="panel stack">
            <h2>Приєднатися за кодом</h2>
            <label>Код події<input name="code" required minLength={8} maxLength={8} placeholder="A1B2C3D4" autoCapitalize="characters" /></label>
            <PendingButton className="secondary-button" pendingLabel="Приєднуємо…">Приєднатися</PendingButton>
          </form>
        </div>
        <section className="panel stack">
          <div><p className="eyebrow">Ваші події</p><h2>{parties.length ? `${parties.length} активних/минулих` : "Подій ще немає"}</h2></div>
          <div className="party-list">
            {parties.map((party) => (
              <Link className="party-row" href={`/party/${party.code}`} key={party.id}>
                <span><strong>{party.title}</strong><small>{party.role === "host" ? "Організатор" : "Учасник"} · {party.code}</small></span>
                <span className={`status-pill ${party.status}`}>{party.status === "finalized" ? "Фіналізовано" : party.budget_cents ? formatMoney(party.budget_cents) : "Без бюджету"}</span>
              </Link>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
