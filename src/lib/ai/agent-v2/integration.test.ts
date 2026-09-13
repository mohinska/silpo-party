import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createCartOperationRepository } from "./cart-repository";
import { deriveProductRequirement } from "./recipes";
import { applyRequestEdit, createWorkspace } from "./state";
import { CartSnapshotSchema, retryAfterMilliseconds } from "./commerce-contract";

it("sends immutable preparation and original worker authority through the repository", async () => {
  const sent: { name: string; args: Record<string, unknown> }[] = [];
  const repository = createCartOperationRepository(async (name, args) => { sent.push({ name, args }); return { data: null, error: null }; });
  await repository.finish({ operationId: "00000000-0000-4000-8000-000000000001", workerId: "original-worker", status: "unknown", readback: null, privateError: "write_requires_reconciliation" });
  expect(sent).toEqual([{ name: "agent_v2_cart_finish", args: { p_operation_id: "00000000-0000-4000-8000-000000000001", p_worker_id: "original-worker", p_status: "unknown", p_readback: null, p_private_error: "write_requires_reconciliation" } }]);
  const failed = createCartOperationRepository(async () => ({ data: null, error: { message: "Pending source events", code: "P0001" } }));
  await expect(failed.acquire({ operationId: "00000000-0000-4000-8000-000000000001", actorId: "00000000-0000-4000-8000-000000000001", workerId: "worker", cartId: "cart" })).rejects.toMatchObject({ code: "P0001" });
});
it("requires direct-product quantities and units before deriving a requirement", () => {
  let workspace = applyRequestEdit(createWorkspace("p", ["h"]), "h", { kind: "add", requestId: "r", text: "milk", requestKind: "product" });
  expect(() => deriveProductRequirement(workspace, "r", { fat: "3.2%" })).toThrow(/quantity/i);
  workspace = applyRequestEdit(workspace, "h", { kind: "quantity", requestId: "r", quantity: 2, unit: "l" });
  expect(deriveProductRequirement(workspace, "r", { fat: "3.2%" }).quantity).toBe(2);
});
it("sanitizes capture schemas without credentials, personal defaults or descriptions", async () => {
  const output = join(mkdtempSync(join(tmpdir(), "silpo-schema-test-")), "capture.json");
  const raw = { tools: [{ name: "silpo_get_my_profile", description: "private-person@example.com", inputSchema: { type: "object", properties: { user: { type: "string", default: "secret-token", examples: ["private-person@example.com"], description: "private-person@example.com" } } } }] };
  const { writeSanitizedCapture } = await import("../../../../scripts/capture-silpo-contract.mjs");
  await writeSanitizedCapture(raw.tools, output, false);
  const serialized = readFileSync(output, "utf8");
  expect(serialized).not.toContain("secret-token"); expect(serialized).not.toContain("private-person");
  expect(JSON.parse(serialized).tools[0].inputSchema.properties.user).toEqual({ type: "string" });
  expect(JSON.parse(serialized).provenance).toBe("sanitized-test-fixture-NOT-live");
});
it("fails closed on unsupported discounted cart totals and parses date Retry-After", () => {
  expect(CartSnapshotSchema.safeParse({ cartId: "cart", companyId: "co", branchId: "br", deliveryType: "SelfPickup", timeslotStart: "2026-09-14T10:00:00Z", timeslotEnd: "2026-09-14T11:00:00Z", lines: [{ productId: "p", companyId: "co", branchId: "br", quantity: 1, unitPriceCents: 100, lineTotalCents: 90 }], totalCents: 90, validationErrors: [] }).success).toBe(false);
  expect(retryAfterMilliseconds("Sun, 13 Sep 2026 10:00:02 GMT", Date.parse("2026-09-13T10:00:00Z"))).toBe(2000);
});
