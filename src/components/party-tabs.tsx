"use client";

import { useState, type ReactNode } from "react";
import { selectPartyTab, type PartyTabId } from "./party-tabs-state";

export function PartyTabs({ chat, basket }: { chat: ReactNode; basket: ReactNode }) {
  const [activeTab, setActiveTab] = useState<PartyTabId>("chat");

  return (
    <div className="shopping-tabs party-tabs">
      <div className="tab-switcher" role="tablist" aria-label="Робоча область події">
        {(["chat", "basket"] as const).map((tab) => (
          <button id={`party-tab-${tab}`} key={tab} type="button" role="tab" aria-selected={activeTab === tab} aria-controls={`party-panel-${tab}`} tabIndex={activeTab === tab ? 0 : -1} className={activeTab === tab ? "active" : ""} onClick={() => setActiveTab(selectPartyTab(activeTab, tab))}>
            {tab === "chat" ? "Чат" : "Кошик"}
          </button>
        ))}
      </div>
      <div id={`party-panel-${activeTab}`} role="tabpanel" tabIndex={0} aria-labelledby={`party-tab-${activeTab}`} aria-label={activeTab === "chat" ? "Чат" : "Кошик"}>{activeTab === "chat" ? chat : basket}</div>
    </div>
  );
}
