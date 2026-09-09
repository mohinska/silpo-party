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
            <h1>AI planning trace</h1>
            <p>
              Приватний інспектор для {displayName}: від MCP-запиту до фінальної
              safety-перевірки.
            </p>
          </div>
        </div>
      </header>

      <DebugForm />
    </main>
  );
}
