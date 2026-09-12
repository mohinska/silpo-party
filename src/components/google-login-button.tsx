export function GoogleLoginButton({ href, label }: { href: string; label: string }) {
  return (
    <a className="google-login-button" href={href}>
      <span className="google-login-mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" role="presentation"><path fill="#4285F4" d="M21.35 12.27c0-.72-.06-1.42-.18-2.09H12v3.96h5.24a4.48 4.48 0 0 1-1.94 2.94v2.45h3.15c1.84-1.69 2.9-4.18 2.9-7.26Z"/><path fill="#34A853" d="M12 21.7c2.63 0 4.84-.87 6.45-2.36l-3.15-2.45c-.87.58-1.98.92-3.3.92-2.54 0-4.7-1.72-5.47-4.03H3.28v2.53A9.74 9.74 0 0 0 12 21.7Z"/><path fill="#FBBC05" d="M6.53 13.78a5.84 5.84 0 0 1 0-3.56V7.69H3.28a9.74 9.74 0 0 0 0 8.62l3.25-2.53Z"/><path fill="#EA4335" d="M12 6.19c1.43 0 2.72.49 3.73 1.45l2.8-2.8C16.84 3.27 14.63 2.3 12 2.3a9.74 9.74 0 0 0-8.72 5.39l3.25 2.53C7.3 7.91 9.46 6.19 12 6.19Z"/></svg>
      </span>
      <span className="google-login-copy">{label}</span>
    </a>
  );
}
