"use client";

import { useState, type ReactNode } from "react";
import {
  selectPartyStage,
  type PartyStageId,
} from "./party-stage-state";

const STAGES: Array<{
  id: PartyStageId;
  number: string;
  label: string;
  shortLabel: string;
}> = [
  { id: "guests", number: "1", label: "Гості", shortLabel: "Гості" },
  {
    id: "preferences",
    number: "2",
    label: "Побажання",
    shortLabel: "Їжа",
  },
  {
    id: "shopping",
    number: "3",
    label: "Покупки",
    shortLabel: "Кошик",
  },
  {
    id: "split",
    number: "4",
    label: "Розрахунок",
    shortLabel: "Сума",
  },
];

export function PartyStages({
  guests,
  preferences,
  shopping,
  split,
}: {
  guests: ReactNode;
  preferences: ReactNode;
  shopping: ReactNode;
  split: ReactNode;
}) {
  const [activeStage, setActiveStage] = useState<PartyStageId>("guests");
  const content: Record<PartyStageId, ReactNode> = {
    guests,
    preferences,
    shopping,
    split,
  };

  return (
    <div className="party-flow">
      <nav className="stage-rail" aria-label="Етапи події">
        {STAGES.map((stage) => {
          const active = stage.id === activeStage;
          return (
            <button
              key={stage.id}
              type="button"
              className={active ? "stage-step active" : "stage-step"}
              aria-current={active ? "step" : undefined}
              onClick={() =>
                setActiveStage((current) => selectPartyStage(current, stage.id))
              }
            >
              <span className="stage-number">{stage.number}</span>
              <span className="stage-label">{stage.label}</span>
              <span className="stage-short-label">{stage.shortLabel}</span>
            </button>
          );
        })}
      </nav>

      <section
        className="stage-screen"
        aria-live="polite"
        aria-label={STAGES.find(({ id }) => id === activeStage)?.label}
      >
        {content[activeStage]}
      </section>
    </div>
  );
}

export function ShoppingTabs({ basket }: { basket: ReactNode }) {
  const [activeTab, setActiveTab] = useState<"basket" | "agent">("basket");

  return (
    <div className="shopping-tabs">
      <div className="tab-switcher" role="tablist" aria-label="Покупки">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "basket"}
          className={activeTab === "basket" ? "active" : ""}
          onClick={() => setActiveTab("basket")}
        >
          Кошик
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "agent"}
          className={activeTab === "agent" ? "active" : ""}
          onClick={() => setActiveTab("agent")}
        >
          Чат з агентом <small>скоро</small>
        </button>
      </div>

      {activeTab === "basket" ? (
        <div role="tabpanel">{basket}</div>
      ) : (
        <div className="agent-chat-placeholder" role="tabpanel">
          <div className="agent-orbit" aria-hidden="true">СФ</div>
          <div>
            <h3>Агент приєднається на наступному етапі</h3>
            <p>
              Тут він запропонує страви й сам додасть потрібні продукти до
              кошика. Поки що чат нічого не надсилає і не змінює.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
