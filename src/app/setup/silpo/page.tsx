import { redirect } from "next/navigation";
import Link from "next/link";
import { AppHeader } from "@/components/app-header";
import { requireUser } from "@/lib/auth";
import { getConnectionStatus } from "@/lib/silpo/oauth";

type SilpoSetupProps = { searchParams: Promise<{ next?: string; silpo?: string }> };

function safeNext(value: string | undefined) {
  return value && value.startsWith("/") && !value.startsWith("//") ? value : "/parties";
}

export default async function SilpoSetupPage({ searchParams }: SilpoSetupProps) {
  const user = await requireUser();
  const params = await searchParams;
  const destination = safeNext(params.next);
  if (await getConnectionStatus(user.id).catch(() => null)) redirect(destination);
  return (
    <main className="page-shell setup-page">
      <div className="setup-container">
        <AppHeader user={user} backHref="/" />
        <section className="setup-intro" aria-labelledby="setup-title">
          <p className="eyebrow">Ще один крок</p>
          <h1 id="setup-title">Підключіть свій акаунт «Сільпо»</h1>
          <p className="hero-copy">Так агент зможе бачити ваші вподобання та працювати з вашим кошиком. Ми не зберігаємо пароль.</p>
          {params.silpo === "denied" && <p className="notice">Підключення скасовано. Ви можете спробувати ще раз.</p>}
          {params.silpo?.includes("error") && <p className="notice error">Не вдалося підключити «Сільпо». Спробуйте ще раз.</p>}
          <a className="primary-button setup-button" href={`/auth/silpo/connect?next=${encodeURIComponent(destination)}`}>Увійти через «Сільпо»</a>
          <Link className="text-button setup-skip" href={destination}>Продовжити без підключення</Link>
        </section>
      </div>
    </main>
  );
}
