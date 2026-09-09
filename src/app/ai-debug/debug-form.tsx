"use client";

import { useState } from "react";

import {
  parseDebugStreamChunk,
  type PlanningDebugEvent,
  type PlanningDebugStage,
} from "@/lib/ai/planning/debug-stream";
import styles from "./page.module.css";

const STAGE_LABELS: Record<PlanningDebugStage, string> = {
  request: "Запуск",
  input: "Вхідні дані",
  context: "Контекст Сільпо",
  signals: "Харчові сигнали",
  normalization: "Нормалізація",
  prompt: "Промпт планувальника",
  model: "Виклик моделі",
  contract: "Перевірка схеми",
  safety: "Safety-перевірка",
  result: "Результат",
};

const STATUS_LABELS = {
  started: "виконується",
  completed: "готово",
  failed: "помилка",
} as const;

function JsonPanel({ value }: { value: unknown }) {
  const formatted = JSON.stringify(value, null, 2);

  async function copy() {
    await navigator.clipboard.writeText(formatted);
  }

  return (
    <div className={styles.payload}>
      <button type="button" className={styles.copyButton} onClick={copy}>
        Копіювати JSON
      </button>
      <pre className={styles.json}>{formatted}</pre>
    </div>
  );
}

function TraceEvent({ event, index }: { event: PlanningDebugEvent; index: number }) {
  const details = event.error ?? event.data;

  return (
    <article className={`${styles.traceEvent} ${styles[event.status]}`}>
      <div className={styles.rail} aria-hidden="true">
        <span>{index + 1}</span>
      </div>
      <div className={styles.eventBody}>
        <div className={styles.eventHeading}>
          <div>
            <h3>{STAGE_LABELS[event.stage]}</h3>
            {event.participantId && <p>{event.participantId}</p>}
          </div>
          <div className={styles.eventMeta}>
            <span className={styles[event.status]}>
              {STATUS_LABELS[event.status]}
            </span>
            <time dateTime={event.at}>{event.at.slice(11, 23)}</time>
            {event.durationMs !== undefined && <span>{event.durationMs} ms</span>}
          </div>
        </div>

        {details !== undefined && (
          <details open={event.status === "failed"}>
            <summary>
              {event.error ? "Технічна помилка" : "Переглянути payload"}
            </summary>
            <JsonPanel value={details} />
          </details>
        )}
      </div>
    </article>
  );
}

export function DebugForm() {
  const [events, setEvents] = useState<PlanningDebugEvent[]>([]);
  const [runStatus, setRunStatus] = useState<
    "idle" | "running" | "success" | "error"
  >("idle");
  const [transportError, setTransportError] = useState<string>();

  async function run() {
    setEvents([]);
    setTransportError(undefined);
    setRunStatus("running");

    try {
      const response = await fetch("/api/ai-debug/run", {
        method: "POST",
        headers: { Accept: "application/x-ndjson" },
      });
      if (!response.ok) {
        throw new Error((await response.text()) || `HTTP ${response.status}`);
      }
      if (!response.body) throw new Error("Сервер не повернув потік подій.");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let remainder = "";
      let terminalStatus: "success" | "error" | undefined;

      while (true) {
        const { value, done } = await reader.read();
        const decoded = decoder.decode(value, { stream: !done });
        const parsed = parseDebugStreamChunk(remainder, decoded);
        remainder = parsed.remainder;

        if (parsed.events.length > 0) {
          setEvents((current) => [...current, ...parsed.events]);
          for (const event of parsed.events) {
            if (event.stage === "result") {
              terminalStatus = event.status === "completed" ? "success" : "error";
              setRunStatus(terminalStatus);
            }
          }
        }
        if (done) break;
      }

      if (!terminalStatus) {
        throw new Error("Потік завершився без фінального результату.");
      }
    } catch (error) {
      setTransportError(
        error instanceof Error ? error.message : "Невідома помилка потоку.",
      );
      setRunStatus("error");
    }
  }

  function downloadTrace() {
    const blob = new Blob([JSON.stringify(events, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `ai-debug-${new Date().toISOString()}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  const completedStages = events.filter(({ status }) => status === "completed").length;
  const elapsed = events.at(-1)?.elapsedMs ?? 0;

  return (
    <>
      <section className={styles.controls}>
        <div>
          <h2>Живий прогін</h2>
          <p>
            Реальний MCP-контекст, промпти й відповіді моделі. Запуск нічого не
            записує у кошик або базу даних.
          </p>
        </div>
        <div className={styles.actions}>
          {events.length > 0 && (
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={downloadTrace}
            >
              Завантажити trace
            </button>
          )}
          <button type="button" onClick={run} disabled={runStatus === "running"}>
            {runStatus === "running" ? "Агент працює…" : "Запустити агента"}
          </button>
        </div>
      </section>

      <section className={styles.runSummary} aria-live="polite">
        <div>
          <span>Стан</span>
          <strong className={styles[runStatus]}>
            {runStatus === "idle" && "очікує запуску"}
            {runStatus === "running" && "виконується наживо"}
            {runStatus === "success" && "завершено"}
            {runStatus === "error" && "потрібна увага"}
          </strong>
        </div>
        <div>
          <span>Події</span>
          <strong>{events.length}</strong>
        </div>
        <div>
          <span>Завершено етапів</span>
          <strong>{completedStages}</strong>
        </div>
        <div>
          <span>Час</span>
          <strong>{elapsed} ms</strong>
        </div>
      </section>

      {transportError && (
        <section className={styles.errorPanel}>
          <h2>Помилка з’єднання з debug endpoint</h2>
          <p>{transportError}</p>
        </section>
      )}

      <section className={styles.trace} aria-label="Етапи виконання агента">
        {events.length === 0 ? (
          <div className={styles.emptyTrace}>
            <span aria-hidden="true">●</span>
            <p>Після запуску тут з’являться етапи в порядку виконання.</p>
          </div>
        ) : (
          events.map((event, index) => (
            <TraceEvent
              key={`${event.stage}-${event.status}-${event.participantId ?? "run"}-${index}`}
              event={event}
              index={index}
            />
          ))
        )}
      </section>
    </>
  );
}
