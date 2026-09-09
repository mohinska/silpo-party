import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { getConnectionStatus } from "@/lib/silpo/oauth";
import { getPersonalSilpoContext } from "@/lib/silpo/mcp";
import { savePreferences } from "./actions";

type ProfilePageProps = { searchParams: Promise<{ silpo?: string }> };

export default async function ProfilePage({ searchParams }: ProfilePageProps) {
  const user = await requireUser();
  const supabase = await createClient();
  const [{ data: profile }, connection, params] = await Promise.all([
    supabase.from("profiles").select("allergies, dietary_restrictions, dislikes, preferences").eq("id", user.id).maybeSingle(),
    getConnectionStatus(user.id).catch(() => null),
    searchParams,
  ]);

  let personalContext: Record<string, unknown> | null = null;
  let contextError = false;
  if (connection) {
    try {
      personalContext = await getPersonalSilpoContext(user.id);
    } catch (error) {
      console.error("Unable to fetch personal Silpo context", error);
      contextError = true;
    }
  }

  const name = user.user_metadata.full_name ?? user.user_metadata.name ?? "Користувач";
  return (
    <main className="page-shell">
      <section className="profile-card">
        <nav className="topbar"><Link href="/parties">Мої події</Link><Link href="/">Головна</Link></nav>
        <div className="profile-heading">
          <div>
            <p className="eyebrow">Ваш профіль</p>
            <h1>{name}</h1>
            <p className="muted">{user.email}</p>
          </div>
          <form action="/auth/logout" method="post"><button className="text-button">Вийти</button></form>
        </div>

        {params.silpo === "connected" && <p className="notice success">Акаунт «Сільпо» підключено.</p>}
        {params.silpo?.includes("error") && <p className="notice error">Не вдалося підключити «Сільпо». Спробуйте ще раз.</p>}
        {params.silpo === "denied" && <p className="notice">Підключення скасовано.</p>}

        <section className="connection-panel">
          <div>
            <p className="eyebrow">Персональний контекст</p>
            <h2>Акаунт «Сільпо»</h2>
            <p className="muted">
              {connection
                ? "Підключено. Дані читаються тільки на сервері через вашу MCP-сесію."
                : "Не підключено. Ви все одно можете заповнити вподобання нижче."}
            </p>
          </div>
          {connection ? (
            <form action="/auth/silpo/disconnect" method="post"><button className="secondary-button">Відключити</button></form>
          ) : (
            <a className="primary-button" href="/auth/silpo/connect">Підключити Сільпо</a>
          )}
        </section>

        {connection && (
          <section className="context-panel">
            <h2>Дані з «Сільпо»</h2>
            {contextError || !personalContext ? (
              <p className="muted">Сесію підключено, але персональний контекст зараз недоступний.</p>
            ) : (
              <ul className="context-list">
                {Object.keys(personalContext).map((tool) => (
                  <li key={tool}><span>✓</span>{tool.replace("silpo_get_my_", "")}</li>
                ))}
              </ul>
            )}
          </section>
        )}

        <form action={savePreferences} className="preferences-form">
          <div><p className="eyebrow">Резервний профіль</p><h2>Ваші харчові потреби</h2><p className="muted">Ці дані працюють навіть без підключення «Сільпо».</p></div>
          <label>Алергії<textarea name="allergies" defaultValue={profile?.allergies ?? ""} placeholder="Наприклад: арахіс" /></label>
          <label>Дієтичні обмеження<textarea name="dietary_restrictions" defaultValue={profile?.dietary_restrictions ?? ""} placeholder="Наприклад: без глютену" /></label>
          <label>Не люблю<textarea name="dislikes" defaultValue={profile?.dislikes ?? ""} placeholder="Наприклад: кінза" /></label>
          <label>Вподобання<textarea name="preferences" defaultValue={profile?.preferences ?? ""} placeholder="Наприклад: більше овочів" /></label>
          <button className="primary-button" type="submit">Зберегти профіль</button>
        </form>
      </section>
    </main>
  );
}
