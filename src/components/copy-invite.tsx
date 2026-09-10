"use client";

import { useState } from "react";

export function CopyInvite({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  const [copying, setCopying] = useState(false);
  async function copy() {
    if (copying) return;
    setCopying(true);
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } finally {
      setCopying(false);
    }
  }
  return <button className="secondary-button" type="button" onClick={copy} disabled={copying}>{copying ? "Копіюємо…" : copied ? "Скопійовано ✓" : "Скопіювати посилання"}</button>;
}
