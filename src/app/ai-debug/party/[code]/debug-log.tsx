import type { DebugPartyWorkspace } from "@/lib/ai/debug-party/repository";
import { participantName } from "./participant-name";
import styles from "../../page.module.css";

const statuses = { queued: "У черзі", running: "Виконується", completed: "Готово", failed: "Помилка" };
const errorDetails: Record<string, string> = {
  RECIPE_SOURCE_FAILED: "Рецепт не знайдено або джерело не віддало повний список інгредієнтів.",
  MCP_401: "Сесія Silpo завершилась — перепідключіть акаунт.",
  MCP_403: "Silpo не дозволив цю операцію для підключеного акаунта.",
  MCP_404: "Silpo не знайшов запитаний ресурс.",
  MCP_408: "Silpo не відповів вчасно.",
  MCP_429: "Silpo тимчасово обмежив кількість запитів.",
  MCP_500: "У Silpo тимчасова серверна помилка.",
  MCP_502: "Шлюз Silpo тимчасово недоступний.",
  MCP_503: "Сервіс Silpo тимчасово недоступний.",
  MCP_504: "Silpo не відповів вчасно.",
  MCP_OPERATION_FAILED: "Silpo MCP не завершив операцію. Нижче вказано точний інструмент.",
};

export function DebugLog({ workspace }: { workspace: DebugPartyWorkspace }) {
  return <section id="party-log" className={styles.logPanel} aria-label="Журнал роботи помічника">
    <details className={styles.debugDrawer}>
      <summary>Лог помічника <span>{workspace.toolEvents?.length ?? 0} подій</span></summary>
      <p className={styles.muted}>Статуси та безпечні технічні метадані. Без вмісту відповідей інструментів.</p>
      {workspace.runs?.length ? <ul className={styles.runList}>{workspace.runs.map((run) => <li key={run.id}><strong>{participantName(workspace, run.actorId)}</strong><span>{run.mode === "preprocess" ? "Підготовка контексту" : run.mode === "build" ? "Перебудова кошика" : "Запит у чаті"}</span><span>{statuses[run.status]}</span><code title={run.id}>{run.id.slice(0, 8)}</code></li>)}</ul> : <p>Запусків ще немає. Напишіть перше повідомлення.</p>}
      <ol className={styles.toolEvents}>{workspace.toolEvents?.map((event) => <li key={event.id}>
        <div><time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "Europe/Kyiv" })}</time><code>{event.toolName}</code><span>{statuses[event.status]}</span></div>
        <small>Запуск <code title={event.runId}>{event.runId.slice(0, 8)}</code>{event.durationMs !== null && ` · ${event.durationMs} мс`}{event.count !== null && ` · ${event.count} результатів`}</small>
        {event.status === "failed" && <p className={styles.error}>{event.errorCode ? errorDetails[event.errorCode] ?? "Інструмент не завершив операцію." : "Інструмент не завершив операцію."}{event.mcpTool && <> MCP: <code>{event.mcpTool}</code></>}{event.errorCode && <> · код: <code>{event.errorCode}</code></>}</p>}
      </li>)}</ol>
    </details>
  </section>;
}
