"use client";

import { useState, type ReactNode } from "react";
import { selectPartyTab, type PartyTabId } from "./party-tabs-state";

export function PartyTabs({ chat, basket }: { chat: ReactNode; basket: ReactNode }) {
  const [activeTab, setActiveTab] = useState<PartyTabId>("chat");

  return (
    <div className="shopping-tabs party-tabs">
      <div className="tab-switcher" role="tablist" aria-label="Робоча область події">
        {(["chat", "basket"] as const).map((tab) => (
          <button key={tab} type="button" role="tab" aria-selected={activeTab === tab} className={activeTab === tab ? "active" : ""} onClick={() => setActiveTab(selectPartyTab(activeTab, tab))}>
            {tab === "chat" ? "Чат" : "Кошик"}
          </button>
        ))}
      </div>
      <div role="tabpanel" aria-label={activeTab === "chat" ? "Чат" : "Кошик"}>{activeTab === "chat" ? chat : basket}</div>
    </div>
  );
}
