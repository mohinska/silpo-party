declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (request: Request) => Response | Promise<Response>): void;
};

const workerUrl = Deno.env.get("NEXT_APP_URL") ?? Deno.env.get("NEXT_PUBLIC_APP_URL");
const workerSecret = Deno.env.get("AGENT_WORKER_SECRET");

function authorized(request: Request) {
  const expected = Deno.env.get("AGENT_DISPATCHER_SECRET");
  return Boolean(expected && request.headers.get("authorization") === `Bearer ${expected}`);
}

Deno.serve(async (request) => {
  if (request.method !== "POST" || !authorized(request)) {
    return new Response(JSON.stringify({ error: "Unauthorized." }), { status: 401, headers: { "content-type": "application/json" } });
  }
  if (!workerUrl || !workerSecret) {
    return new Response(JSON.stringify({ error: "Agent worker is not configured." }), { status: 500, headers: { "content-type": "application/json" } });
  }
  const body = await request.text();
  const response = await fetch(`${workerUrl.replace(/\/$/, "")}/api/internal/agent-runs`, {
    method: "POST",
    headers: { authorization: `Bearer ${workerSecret}`, "content-type": "application/json" },
    body,
  });
  return new Response(await response.text(), { status: response.status, headers: { "content-type": "application/json" } });
});
