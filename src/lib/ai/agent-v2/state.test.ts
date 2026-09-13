import { describe, expect, it } from "vitest";
import { applyRequestEdit, createWorkspace, invalidateArtifacts, refreshContext, effectiveRules, WorkspaceSchema } from "./state";
import { evaluateEvidence, calculateDraft, publishDraft, projectDraft } from "./draft";

const add = { kind: "add" as const, requestId: "r1", text: "Rice", requestKind: "dish" as const };
const rule = { id: "milk", kind: "exclude_term" as const, value: "milk", source: "profile", evidenceRef: "private-e1" };
const ownedSemanticRule = { id: "vegan", kind: "semantic" as const, value: "vegan", source: "profile", evidenceRef: "private-e2", ownerId: "a" };
const evidence = { id: "e1", source: "product_details" as const, sourceRef: "product:123", complete: true, ingredients: ["rice"], composition: "rice", verified: true };
const productEvidence = { ...evidence, productIdentity: { productId: "prod", companyId: "c", branchId: "b" } };

describe("versioned private workspace", () => {
  it("defaults own request to own eater without assigning unsubmitted members", () => {
    const state = applyRequestEdit(createWorkspace("p", ["a", "b"]), "a", add);
    expect(state.requests[0].eaterIds).toEqual(["a"]);
    expect(state.participants.b.submission).toBe("unsubmitted");
    expect(state.inputRevision).toBe(1);
    expect(state.draftRevision).toBe(0);
  });
  it("keeps IDs stable on replacement, ignores no-op edits and pure questions", () => {
    const state = applyRequestEdit(createWorkspace("p", ["a"]), "a", add);
    expect(applyRequestEdit(state, "a", { kind: "question", text: "How much?" })).toEqual(state);
    expect(applyRequestEdit(state, "a", { kind: "servings", requestId: "r1", servings: 1 })).toEqual(state);
    const changed = applyRequestEdit(state, "a", { kind: "replace", requestId: "r1", text: "Pasta", requestKind: "dish" });
    expect(changed.requests[0]).toMatchObject({ id: "r1", text: "Pasta", version: 2 });
    expect(changed.inputRevision).toBe(2);
  });
  it("requires explicit valid group eaters and prevents editing another member's request", () => {
    const state = applyRequestEdit(createWorkspace("p", ["a", "b"]), "a", { ...add, eaterIds: ["a", "b"] });
    expect(state.requests[0].eaterIds).toEqual(["a", "b"]);
    expect(() => applyRequestEdit(state, "b", { kind: "remove", requestId: "r1" })).toThrow();
    expect(() => applyRequestEdit(state, "a", { kind: "eaters", requestId: "r1", eaterIds: ["stranger"] })).toThrow();
    expect(() => applyRequestEdit(state, "a", { kind: "quantity", requestId: "r1", quantity: 0, unit: "g" })).toThrow();
  });
  it("marks an indifferent participant explicitly and removes only their requests", () => {
    let state = applyRequestEdit(createWorkspace("p", ["a", "b"]), "a", add);
    state = applyRequestEdit(state, "b", { ...add, requestId: "r2", text: "Pasta" });
    const next = applyRequestEdit(state, "a", { kind: "indifferent" });
    expect(next.participants.a.submission).toBe("indifferent");
    expect(next.participants.b.submission).toBe("submitted");
    expect(next.requests.map(request => request.id)).toEqual(["r2"]);
    expect(next.inputRevision).toBe(3);
  });
  it("upserts a trusted stable participant request across repeated submissions", () => {
    const initial = createWorkspace("p", ["a"]);
    const added = applyRequestEdit(initial, "a", { kind: "upsert", requestId: "primary", text: "Rice", requestKind: "dish" });
    const replaced = applyRequestEdit(added, "a", { kind: "upsert", requestId: "primary", text: "Pasta", requestKind: "dish" });
    expect(replaced.requests).toMatchObject([{ id: "primary", text: "Pasta", version: 2 }]);
    expect(replaced.inputRevision).toBe(2);
  });
  it("invalidates only transitive dependents", () => {
    const artifacts = [
      { id: "recipe", kind: "recipe" as const, version: 1, valid: true, dependsOn: ["request:r1"], evidenceRefs: [] },
      { id: "product", kind: "product" as const, version: 1, valid: true, dependsOn: ["recipe"], evidenceRefs: [] },
      { id: "other", kind: "recipe" as const, version: 1, valid: true, dependsOn: ["request:r2"], evidenceRefs: [] },
    ];
    expect(invalidateArtifacts(artifacts, ["request:r1"]).map(a => a.valid)).toEqual([false, false, true]);
  });
  it.each([
    { kind: "servings" as const, requestId: "r1", servings: 2 },
    { kind: "quantity" as const, requestId: "r1", quantity: 2, unit: "piece" as const },
    { kind: "eaters" as const, requestId: "r1", eaterIds: ["a", "b"] },
  ])("preserves recipe source for $kind while invalidating dependent calculations", edit => {
    const state = applyRequestEdit(createWorkspace("p", ["a", "b"]), "a", add);
    state.artifacts = [
      { id: "recipe", kind: "recipe", version: 1, valid: true, dependsOn: ["request:r1:source"], evidenceRefs: [] },
      { id: "scaled", kind: "requirement", version: 1, valid: true, dependsOn: ["recipe", "request:r1:scaling", "request:r1:eaters"], evidenceRefs: [] },
      { id: "products", kind: "product", version: 1, valid: true, dependsOn: ["scaled"], evidenceRefs: [] },
      { id: "other", kind: "recipe", version: 1, valid: true, dependsOn: ["request:r2:source"], evidenceRefs: [] },
    ];
    expect(applyRequestEdit(state, "a", edit).artifacts.map(a => a.valid)).toEqual([true, false, false, true]);
    expect(applyRequestEdit(state, "a", { kind: "replace", requestId: "r1", text: "Pasta", requestKind: "dish" }).artifacts.map(a => a.valid)).toEqual([false, false, false, true]);
  });
  it("unions participant source rules and retains known constraints on refresh error", () => {
    let state = createWorkspace("p", ["a"]);
    state = refreshContext(state, "a", { source: "profile", version: 1, status: "success", rules: [rule], favorites: [], evidenceRefs: ["private-e1"] });
    state = refreshContext(state, "a", { source: "silpo", version: 1, status: "success", rules: [{ ...rule, id: "nuts", value: "nuts", source: "silpo" }], favorites: [], evidenceRefs: [] });
    state = refreshContext(state, "a", { source: "silpo", version: 2, status: "error", errorCode: "unavailable" });
    expect(effectiveRules(state, ["a"]).map(r => r.value).sort()).toEqual(["milk", "nuts"]);
    expect(state.participants.a.contexts.silpo.status).toBe("error");
    state = refreshContext(state, "a", { source: "silpo", version: 3, status: "success", rules: [], favorites: [], evidenceRefs: [] });
    expect(effectiveRules(state, ["a"]).map(r => r.value)).toEqual(["milk"]);
    expect(() => refreshContext(state, "a", { source: "silpo", version: 2, status: "error", errorCode: "old" })).toThrow();
  });
  it("validates persisted versions and rejects malformed workspace", () => {
    expect(WorkspaceSchema.safeParse({ ...createWorkspace("p", ["a"]), inputRevision: -1 }).success).toBe(false);
  });
});

describe("evidence and deterministic readiness", () => {
  it("does not trust a model safe flag or unsupported semantic restrictions", () => {
    expect(evaluateEvidence([rule], { ...evidence, complete: false }).status).toBe("unknown");
    expect(evaluateEvidence([{ ...rule, kind: "semantic", value: "vegan" }], evidence).status).toBe("unknown");
    expect(evaluateEvidence([rule], { ...evidence, ingredients: ["milk"], composition: "milk" }).status).toBe("unsafe");
    expect(evaluateEvidence([rule], evidence).status).toBe("safe");
    expect(evaluateEvidence([{ ...rule, kind: "semantic", value: "milk allergy" }], { ...evidence, ingredients: ["whey"], composition: "whey" }).status).toBe("unknown");
  });
  it("does not call incomplete composition safe even with no known rules", () => {
    expect(evaluateEvidence([], { ...evidence, complete: false }).status).toBe("unknown");
  });
  it("warns the declaring participant instead of blocking when a semantic rule has a known owner", () => {
    const result = evaluateEvidence([ownedSemanticRule], evidence);
    expect(result.status).toBe("warn");
    expect(result).toMatchObject({ recipientIds: ["a"] });
  });
  it("still blocks a literal exclude_term match even alongside an owned semantic rule", () => {
    expect(evaluateEvidence([rule, ownedSemanticRule], { ...evidence, ingredients: ["milk"], composition: "milk" }).status).toBe("unsafe");
  });
  it("blocks recipe evidence reused as product composition", () => {
    const state = applyRequestEdit(createWorkspace("p", ["a"]), "a", { ...add, requestKind: "product" });
    const requirements = [{ id: "i1", requestId: "r1", name: "Milk", quantity: 1, unit: "g" as const, eaterIds: ["a"], evidenceRefs: ["e1"] }];
    const product = { id: "milk", name: "Milk", companyId: "c", branchId: "b", packageQuantity: 500, packageUnit: "g" as const, priceCents: 1000, available: true, evidence: { ...evidence, source: "recipe_source" as const } };
    expect(calculateDraft(state, requirements, [{ requirementId: "i1", product }], null).ready).toBe(false);
  });
  it("blocks product details without identity proof", () => {
    const state = applyRequestEdit(createWorkspace("p", ["a"]), "a", { ...add, requestKind: "product" });
    const requirements = [{ id: "i1", requestId: "r1", name: "Milk", quantity: 1, unit: "g" as const, eaterIds: ["a"], evidenceRefs: ["e1"] }];
    const product = { id: "milk", name: "Milk", companyId: "c", branchId: "b", packageQuantity: 500, packageUnit: "g" as const, priceCents: 1000, available: true, evidence };
    expect(calculateDraft(state, requirements, [{ requirementId: "i1", product }], null).ready).toBe(false);
  });
  it.each([
    { productId: "wrong", companyId: "c", branchId: "b" },
    { productId: "prod", companyId: "wrong", branchId: "b" },
    { productId: "prod", companyId: "c", branchId: "wrong" },
  ])("blocks composition for a different catalog identity: $productId/$companyId/$branchId", productIdentity => {
    const state = applyRequestEdit(createWorkspace("p", ["a"]), "a", { ...add, requestKind: "product" });
    const requirements = [{ id: "i1", requestId: "r1", name: "Rice", quantity: 1, unit: "g" as const, eaterIds: ["a"], evidenceRefs: ["e1"] }];
    const product = { id: "prod", name: "Rice", companyId: "c", branchId: "b", packageQuantity: 500, packageUnit: "g" as const, priceCents: 1000, available: true, evidence: { ...evidence, productIdentity } };
    const draft = calculateDraft(state, requirements, [{ requirementId: "i1", product }], null);
    expect(draft.ready).toBe(false);
    expect(draft.blockers).toMatchObject([{ code: "unknown", requirementId: "i1" }]);
  });
  it("rounds packages after aggregation and blocks missing required ingredients", () => {
    const state = applyRequestEdit(createWorkspace("p", ["a"]), "a", add);
    state.evidence = [{ ...evidence, source: "recipe_source" }];
    const requirements = [{ id: "i1", requestId: "r1", name: "Rice", quantity: 0.6, unit: "kg" as const, eaterIds: ["a"], evidenceRefs: ["e1"] }];
    const product = { id: "prod", name: "Rice", companyId: "c", branchId: "b", packageQuantity: 500, packageUnit: "g" as const, priceCents: 1000, available: true, evidence: productEvidence };
    const draft = calculateDraft(state, requirements, [{ requirementId: "i1", product }], null);
    expect(draft.lines[0]).toMatchObject({ packageCount: 2, lineTotalCents: 2000 });
    expect(draft.totalCents).toBe(2000);
    expect(draft.ready).toBe(true);
    expect(calculateDraft(state, requirements, [], null).ready).toBe(false);
    expect(calculateDraft(state, requirements, [{ requirementId: "i1", product }], 1999).ready).toBe(false);
    expect(calculateDraft(state, [], [], null).ready).toBe(false);
  });
  it("validates recipe evidence and invalidated artifacts before readiness", () => {
    let state = applyRequestEdit(createWorkspace("p", ["a"]), "a", add);
    state = refreshContext(state, "a", { source: "profile", version: 1, status: "success", rules: [rule], favorites: [], evidenceRefs: ["private-e1"] });
    const requirement = { id: "i1", requestId: "r1", name: "Rice", quantity: 1, unit: "g" as const, eaterIds: ["a"], evidenceRefs: ["recipe-e1"] };
    const product = { id: "prod", name: "Rice", companyId: "c", branchId: "b", packageQuantity: 500, packageUnit: "g" as const, priceCents: 1000, available: true, evidence: productEvidence };
    expect(calculateDraft(state, [requirement], [{ requirementId: "i1", product }], null).ready).toBe(false);
    state.evidence = [{ ...evidence, id: "recipe-e1", source: "recipe_source", ingredients: ["rice", "milk"], composition: "rice, milk" }];
    expect(calculateDraft(state, [requirement], [{ requirementId: "i1", product }], null).blockers[0].code).toBe("unsafe");
  });
  it("keeps a draft ready with a private warning when only a semantic restriction is unresolved", () => {
    let state = applyRequestEdit(createWorkspace("p", ["a"]), "a", { ...add, requestKind: "product" });
    state = refreshContext(state, "a", { source: "profile", version: 1, status: "success", rules: [ownedSemanticRule], favorites: [], evidenceRefs: ["private-e2"] });
    const requirements = [{ id: "i1", requestId: "r1", name: "Rice", quantity: 500, unit: "g" as const, eaterIds: ["a"], evidenceRefs: ["e1"] }];
    const product = { id: "prod", name: "Rice", companyId: "c", branchId: "b", packageQuantity: 500, packageUnit: "g" as const, priceCents: 1000, available: true, evidence: productEvidence };
    const draft = calculateDraft(state, requirements, [{ requirementId: "i1", product }], null);
    expect(draft.ready).toBe(true);
    expect(draft.blockers).toEqual([]);
    expect(draft.warnings).toMatchObject([{ code: "dietary_unverified", requirementId: "i1", recipientId: "a" }]);
  });
  it("produces no warnings for a participant with no declared restriction", () => {
    const state = applyRequestEdit(createWorkspace("p", ["a"]), "a", { ...add, requestKind: "product" });
    const requirements = [{ id: "i1", requestId: "r1", name: "Rice", quantity: 500, unit: "g" as const, eaterIds: ["a"], evidenceRefs: ["e1"] }];
    const product = { id: "prod", name: "Rice", companyId: "c", branchId: "b", packageQuantity: 500, packageUnit: "g" as const, priceCents: 1000, available: true, evidence: productEvidence };
    expect(calculateDraft(state, requirements, [{ requirementId: "i1", product }], null).warnings).toEqual([]);
  });
  it("never rounds a positive requirement down across a package boundary", () => {
    const state = applyRequestEdit(createWorkspace("p", ["a"]), "a", { ...add, requestKind: "product" });
    const product = { id: "prod", name: "Rice", companyId: "c", branchId: "b", packageQuantity: 500, packageUnit: "g" as const, priceCents: 1000, available: true, evidence: productEvidence };
    const requirements = [{ id: "i1", requestId: "r1", name: "Rice", quantity: 500.0001, unit: "g" as const, eaterIds: ["a"], evidenceRefs: ["e1"] }];
    expect(calculateDraft(state, requirements, [{ requirementId: "i1", product }], null).lines[0].packageCount).toBe(2);
  });
  it("separates publication revisions and strips private context/evidence/reasons", () => {
    const state = applyRequestEdit(createWorkspace("p", ["a"]), "a", add);
    const draft = calculateDraft(state, [], [], null);
    const next = publishDraft(state, draft, 1, 0);
    expect(next.draftRevision).toBe(1);
    expect(publishDraft(next, draft, 1, 1).draftRevision).toBe(1);
    expect(() => publishDraft(next, draft, 0, 1)).toThrow();
    const serialized = JSON.stringify(projectDraft(next));
    expect(serialized).not.toContain("evidence");
    expect(serialized).not.toContain("contexts");
    expect(serialized).not.toContain("reason");
  });
  it("never publishes draft.warnings in the shared projection", () => {
    let state = applyRequestEdit(createWorkspace("p", ["a"]), "a", { ...add, requestKind: "product" });
    state = refreshContext(state, "a", { source: "profile", version: 1, status: "success", rules: [ownedSemanticRule], favorites: [], evidenceRefs: ["private-e2"] });
    const requirements = [{ id: "i1", requestId: "r1", name: "Rice", quantity: 500, unit: "g" as const, eaterIds: ["a"], evidenceRefs: ["e1"] }];
    const product = { id: "prod", name: "Rice", companyId: "c", branchId: "b", packageQuantity: 500, packageUnit: "g" as const, priceCents: 1000, available: true, evidence: productEvidence };
    const draft = calculateDraft(state, requirements, [{ requirementId: "i1", product }], null);
    expect(draft.warnings).not.toEqual([]);
    const next = publishDraft(state, draft, state.inputRevision, 0);
    const serialized = JSON.stringify(projectDraft(next));
    expect(serialized).not.toContain("warning");
    expect(serialized).not.toContain("dietary_unverified");
  });
});
