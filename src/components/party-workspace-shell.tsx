"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { PartyRealtime } from "./party-realtime";

export function PartyWorkspaceShell({
  basket,
  details,
  chat,
  actions,
  debug,
  partyId,
  agentStatus,
}: {
  basket: ReactNode;
  details: ReactNode;
  chat: ReactNode;
  actions: ReactNode;
  debug: ReactNode;
  partyId: string;
  agentStatus?: string | null;
}) {
  const [chatOpen, setChatOpen] = useState(false);
  const [chatFullscreen, setChatFullscreen] = useState(false);
  const chatRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!chatOpen || !chatFullscreen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    chatRef.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
    return () => { document.body.style.overflow = previousOverflow; };
  }, [chatOpen, chatFullscreen]);

  return (
    <div className={`party-shell${chatOpen ? " chat-open" : ""}${chatFullscreen ? " chat-fullscreen" : ""}`}>
      <PartyRealtime partyId={partyId} />
      <div className="party-content">
        {basket}
        <div className="chat-panel">
          <div className="chat-panel-header">
            <div><p className="section-kicker">Керування кошиком</p><h2>Чат з агентом</h2></div>
            <div className="chat-panel-header-actions">{agentStatus && <span className="agent-live-status" aria-live="polite">{agentStatus}</span>}<button className="chat-expand-button" type="button" onClick={() => { setChatOpen(true); setChatFullscreen(true); }} aria-haspopup="dialog" aria-expanded={chatFullscreen}>Розгорнути</button></div>
          </div>
          {chat}
          <div className="chat-panel-actions">{actions}</div>
        </div>
        {details}
      </div>
      <div ref={chatRef} className={`chat-surface${chatFullscreen ? " is-open" : ""}`} role="dialog" aria-modal={chatFullscreen} aria-label="Чат з агентом" aria-hidden={!chatFullscreen}>
        <div className="chat-surface-header">
          <div><p className="section-kicker">Керування кошиком</p><h2>Чат з агентом</h2>{agentStatus && <p className="agent-live-status" aria-live="polite">{agentStatus}</p>}</div>
          <button className="icon-button" type="button" onClick={() => { setChatFullscreen(false); setChatOpen(false); }} aria-label="Закрити чат">×</button>
        </div>
        {chat}
        <div className="chat-surface-actions">{actions}</div>
      </div>
      <details className="debug-drawer"><summary>Дані для розробника</summary><div className="debug-content">{debug}</div></details>
    </div>
  );
}
