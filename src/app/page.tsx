import Link from "next/link";
import { getCurrentUser } from "@/lib/auth";
import { AppHeader } from "@/components/app-header";
import { GoogleLoginButton } from "@/components/google-login-button";

export default async function Home() {
  const user = await getCurrentUser();
  return (
    <main className="landing">
      {user && <AppHeader user={user} backHref="/" />}
      <section className="hero-card">
        <div className="brand-mark">СФ</div>
        <p className="eyebrow">Сільпо Family</p>
        <h1>Спільний план. Спільний бюджет. Один кошик.</h1>
        <p className="hero-copy">
          Враховуємо побажання та обмеження кожного учасника події й складаємо один оптимальний кошик.
        </p>
        {user ? (
          <div className="hero-actions"><Link className="primary-button" href="/parties">Мої події</Link></div>
        ) : (
          <GoogleLoginButton href="/auth/google" label="Продовжити з Google" />
        )}
        <p className="privacy-note">Вхід створює ваш окремий акаунт у застосунку.</p>
      </section>
    </main>
  );
}
