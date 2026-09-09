import Link from "next/link";
import { getCurrentUser } from "@/lib/auth";

export default async function Home() {
  const user = await getCurrentUser();
  return (
    <main className="landing">
      <section className="hero-card">
        <div className="brand-mark">СФ</div>
        <p className="eyebrow">Сільпо Family</p>
        <h1>Спільний план. Спільний бюджет. Один кошик.</h1>
        <p className="hero-copy">
          Враховуємо побажання та обмеження кожного учасника події й складаємо один оптимальний кошик.
        </p>
        {user ? (
          <div className="hero-actions"><Link className="primary-button" href="/parties">Мої події</Link><Link className="secondary-button" href="/profile">Профіль</Link></div>
        ) : (
          <a className="google-button" href="/auth/google">
            <span className="google-g">G</span> Увійти через Google
          </a>
        )}
        <p className="privacy-note">Вхід створює ваш окремий акаунт у застосунку.</p>
      </section>
    </main>
  );
}
