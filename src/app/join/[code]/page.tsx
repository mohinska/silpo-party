import Link from "next/link";
import { getCurrentUser } from "@/lib/auth";
import { joinParty } from "@/app/parties/actions";

export default async function JoinPage({ params }: PageProps<"/join/[code]">) {
  const { code: rawCode } = await params;
  const code = rawCode.trim().toUpperCase();
  const user = await getCurrentUser();
  const joinAction = joinParty.bind(null, code);
  return (
    <main className="landing">
      <section className="hero-card compact-card">
        <div className="brand-mark">🎉</div>
        <p className="eyebrow">Запрошення до події</p>
        <h1>Вас запросили до спільного кошика</h1>
        <p className="hero-copy">Код події: <strong>{code}</strong>. Учасникам не потрібно підключати акаунт «Сільпо».</p>
        {user ? (
          <form action={joinAction}><button className="primary-button" type="submit">Приєднатися</button></form>
        ) : (
          <a className="google-button" href={`/auth/google?next=${encodeURIComponent(`/join/${code}`)}`}><span className="google-g">G</span> Увійти й приєднатися</a>
        )}
        <p className="privacy-note"><Link href="/">На головну</Link></p>
      </section>
    </main>
  );
}
