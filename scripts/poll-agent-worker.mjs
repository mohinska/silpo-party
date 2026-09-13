const baseUrl = process.env.AGENT_WORKER_URL?.replace(/\/$/, "") || "http://127.0.0.1:3000";
const secret = process.env.AGENT_WORKER_SECRET;
if (!secret) throw new Error("AGENT_WORKER_SECRET is required.");

async function tick() {
  const response = await fetch(`${baseUrl}/api/internal/agent-runs`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: "{}",
  });
  if (!response.ok) throw new Error(`Worker returned ${response.status}`);
  process.stdout.write(`${await response.text()}\n`);
}

await tick();
setInterval(() => { void tick().catch(error => process.stderr.write(`${error.message}\n`)); }, 5_000);
