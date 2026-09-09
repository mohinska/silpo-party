"use client";

import { useState } from "react";

export function CopyInvite({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(url);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }
  return <button className="secondary-button" type="button" onClick={copy}>{copied ? "Скопійовано ✓" : "Скопіювати посилання"}</button>;
}
