"use client";

import { useActionState } from "react";

import {
  runDebugPlanning,
  type DebugPlanningState,
} from "./actions";
import styles from "./page.module.css";

const initialState: DebugPlanningState = { status: "idle" };

function JsonPanel({ value }: { value: unknown }) {
  return <pre className={styles.json}>{JSON.stringify(value, null, 2)}</pre>;
}

export function DebugForm() {
  const [state, formAction, pending] = useActionState(
    runDebugPlanning,
    initialState,
  );

  return (
    <>
      <form action={formAction} className={styles.controls}>
        <div>
          <h2>Живий тест</h2>
          <p>
            Gemini викличе MCP для вашого акаунта й побудує тимчасовий план на
            одну людину з бюджетом 1000 UAH.
          </p>
        </div>
        <button type="submit" disabled={pending}>
          {pending ? "Gemini аналізує…" : "Зібрати контекст і спланувати"}
        </button>
      </form>

      <p className={styles.status} aria-live="polite">
        {state.status === "idle" && "Запит ще не запускався."}
        {state.status === "success" && "Структуровану відповідь отримано."}
        {state.status === "error" &&
          `Виконання зупинено: ${state.error.message}`}
      </p>

      {state.status === "error" && (
        <section className={styles.errorPanel}>
          <h2>Помилка або safety block</h2>
          <JsonPanel value={state.error} />
        </section>
      )}

      {state.status !== "idle" && (
        <section className={styles.panel}>
          <div className={styles.panelHeading}>
            <h2>Дані від MCP «Сільпо»</h2>
            <span>очищено від секретів</span>
          </div>
          <JsonPanel
            value={
              state.status === "success"
                ? state.result.contextTrace
                : state.contextTrace
            }
          />
        </section>
      )}

      {state.status === "success" && (
        <div className={styles.results}>
          <section className={styles.panel}>
            <div className={styles.panelHeading}>
              <h2>Що зрозумів Gemini</h2>
              <span>participantInsights</span>
            </div>
            <JsonPanel value={state.result.plan.participantInsights} />
          </section>

          <section className={styles.panel}>
            <div className={styles.panelHeading}>
              <h2>Страви та їдці</h2>
              <span>{state.result.plan.status}</span>
            </div>
            <JsonPanel value={state.result.plan.dishes} />
          </section>

          <section className={styles.panel}>
            <div className={styles.panelHeading}>
              <h2>Конфлікти та рішення</h2>
              <span>safety-aware</span>
            </div>
            <JsonPanel
              value={{
                conflicts: state.result.plan.conflicts,
                proposedResolutions: state.result.plan.proposedResolutions,
              }}
            />
          </section>

          <section className={styles.panel}>
            <div className={styles.panelHeading}>
              <h2>Перевірки обмежень</h2>
              <span>fail-closed</span>
            </div>
            <JsonPanel value={state.result.plan.hardConstraintChecks} />
          </section>

          <details className={styles.panel}>
            <summary>Повний input і structured output</summary>
            <JsonPanel value={{ input: state.input, output: state.result.plan }} />
          </details>
        </div>
      )}
    </>
  );
}
