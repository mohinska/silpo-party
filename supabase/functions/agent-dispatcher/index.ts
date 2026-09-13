declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (request: Request) => Response | Promise<Response>): void;
};
declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

const workerUrl = Deno.env.get("NEXT_APP_URL") ?? Deno.env.get("NEXT_PUBLIC_APP_URL");
const workerSecret = Deno.env.get("AGENT_WORKER_SECRET");

function authorized(request: Request) {
  const expected = Deno.env.get("AGENT_DISPATCHER_SECRET");
  return Boolean(expected && request.headers.get("x-dispatcher-secret") === expected);
}

Deno.serve(async (request) => {
  if (request.method !== "POST" || !authorized(request)) {
    return new Response(JSON.stringify({ error: "Unauthorized." }), { status: 401, headers: { "content-type": "application/json" } });
  }
  if (!workerUrl || !workerSecret) {
    return new Response(JSON.stringify({ error: "Agent worker is not configured." }), { status: 500, headers: { "content-type": "application/json" } });
  }
  const body = await request.text();
  const forward = fetch(`${workerUrl.replace(/\/$/, "")}/api/internal/agent-runs`, {
    method: "POST",
    headers: { authorization: `Bearer ${workerSecret}`, "content-type": "application/json" },
    body,
  });
  // The Node route owns one bounded durable slice. Background registration
  // preserves the dispatch attempt without making the scheduler wait for it.
  EdgeRuntime.waitUntil(forward.catch(() => undefined));
  return new Response(JSON.stringify({ accepted: true }), { status: 202, headers: { "content-type": "application/json" } });
});
