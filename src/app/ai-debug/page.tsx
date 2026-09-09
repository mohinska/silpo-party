import { DebugForm } from "./debug-form";
import { requireUser } from "@/lib/auth";
import styles from "./page.module.css";

export default async function AiDebugPage() {
  const user = await requireUser();
  const displayName =
    user.user_metadata.full_name ??
    user.user_metadata.name ??
    user.email ??
    "Користувач";

  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <a href="/profile" className={styles.backLink}>
          Назад до профілю
        </a>
        <div className={styles.titleRow}>
          <div className={styles.pulse} aria-hidden="true" />
          <div>
            <h1>Gemini × Сільпо</h1>
            <p>
              Тимчасовий приватний інспектор для {displayName}. Жодних записів
              у кошик або базу даних.
            </p>
          </div>
        </div>
      </header>

      <DebugForm />
    </main>
  );
}
