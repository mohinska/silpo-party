import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { PendingButton } from "@/components/pending-button";
import { joinPreinstalledDebugParty } from "./actions";
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
            <span className={styles.brand}>AI Debug Party</span>
            <h1>Спільний кошик</h1>
            <p>
              Приєднуйтеся до спільної тестової вечірки й напишіть у чаті, чого хочеться.
              Перший учасник стає Організатором.
            </p>
          </div>
        </div>
      </header>

      <section className={styles.controls} aria-label="Приєднатися до тестової вечірки">
        <form action={joinPreinstalledDebugParty}>
          <h2>Тестова вечірка</h2>
          <p>Команда працює в одному спільному кошику. Посилання можна передати колегам.</p>
          <PendingButton pendingLabel="Приєднуємося…">Приєднатися до вечірки</PendingButton>
        </form>
      </section>
    </main>
  );
}
