import Link from "next/link";
import type { User } from "@supabase/supabase-js";
import { PendingButton } from "@/components/pending-button";

export function AppHeader({ user, backHref = "/parties" }: { user: User; backHref?: string }) {
  const name = user.user_metadata.full_name ?? user.user_metadata.name ?? "Користувач";
  const initial = name.trim().slice(0, 1).toUpperCase() || "К";
  return (
    <nav className="app-header" aria-label="Головна навігація">
      <Link className="app-wordmark" href={backHref}>Сільпо Family</Link>
      <details className="user-menu">
        <summary aria-label="Відкрити меню користувача"><span className="user-avatar" aria-hidden="true">{initial}</span></summary>
        <div className="user-menu-panel">
          <strong>{name}</strong>
          {user.email && <span>{user.email}</span>}
          <form action="/auth/logout" method="post"><PendingButton className="user-menu-action" pendingLabel="Виходимо…">Вийти з акаунту</PendingButton></form>
        </div>
      </details>
    </nav>
  );
}
