import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { createDebugParty, joinDebugParty } from "./actions";
import styles from "./page.module.css";

export default async function AiDebugPage() {
  await requireUser();

  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <Link href="/profile" className={styles.backLink}>
          Назад до профілю
        </Link>
        <div className={styles.titleRow}>
          <div className={styles.pulse} aria-hidden="true" />
          <div>
            <h1>Спільний кошик</h1>
            <p>
              Створіть вечірку, запросіть друзів і напишіть у чаті, чого хочеться.
              AI допоможе зібрати кошик для всіх.
            </p>
          </div>
        </div>
      </header>

      <section className={styles.controls} aria-label="Створити або приєднатися">
        <form action={createDebugParty}>
          <h2>Нова вечірка</h2>
          <p><label htmlFor="budget">Бюджет, грн · необов’язково</label></p>
          <input id="budget" name="budget" type="number" min="0" step="0.01" placeholder="Без обмеження" />
          <button type="submit">Створити вечірку</button>
        </form>
        <form action={joinDebugParty}>
          <h2>Маєте запрошення?</h2>
          <p><label htmlFor="code">Код вечірки · 8 символів</label></p>
          <input id="code" name="code" required minLength={8} maxLength={8} pattern="[A-Za-z0-9]{8}" autoCapitalize="characters" autoComplete="off" />
          <button type="submit">Приєднатися</button>
        </form>
      </section>
    </main>
  );
}
