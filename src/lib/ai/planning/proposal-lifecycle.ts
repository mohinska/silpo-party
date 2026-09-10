import type { MealProposal, ProductLine } from "./proposal-schemas";

type CartSnapshot = { lines: Array<{ productId: string; companyId: string; branchId: string; quantity: number }> };
type Dependencies = {
  loadProposal(id: string, partyId: string): Promise<MealProposal>;
  loadManualLines(partyId: string): Promise<unknown[]>;
  loadAiLines(partyId: string): Promise<unknown[]>;
  replaceAiLines(partyId: string, lines: ProductLine[], manualLines: unknown[]): Promise<void>;
  writeCart(lines: ProductLine[], manualLines: unknown[], previousAiLines: unknown[]): Promise<void>;
  readCart(): Promise<CartSnapshot>;
  markProposal(id: string, status: "rejected" | "applying" | "applied" | "failed", error?: string): Promise<void>;
};

const publicFailure = "Silpo cart synchronization failed. You can retry safely.";
class CartReadBackError extends Error {}

export async function confirmMealProposal(input: { partyId: string; proposalId: string; actorId: string; hostId: string; confirmed: boolean }, deps: Dependencies) {
  if (input.actorId !== input.hostId) throw new Error("Only the Host may confirm a meal proposal.");
  const proposal = await deps.loadProposal(input.proposalId, input.partyId);
  if (proposal.partyId !== input.partyId || !["pending", "failed"].includes(proposal.status)) throw new Error("This proposal cannot be applied.");
  if (!input.confirmed) { await deps.markProposal(proposal.id, "rejected"); return { status: "rejected" as const }; }
  if (proposal.budgetStatus !== "within" || proposal.unresolved.length) throw new Error("Resolve the proposal warnings before confirmation.");
  await deps.markProposal(proposal.id, "applying");
  try {
    const manual = await deps.loadManualLines(input.partyId);
    const previousAi = await deps.loadAiLines(input.partyId);
    await deps.writeCart(proposal.productLines, manual, previousAi);
    const cart = await deps.readCart();
    for (const line of proposal.productLines) {
      const actual = cart.lines.find((item) => item.productId === line.productId && item.companyId === line.companyId && item.branchId === line.branchId);
      if (!actual || actual.quantity < line.packageCount) throw new CartReadBackError("Cart read-back validation failed; the proposal remains retryable.");
    }
    await deps.replaceAiLines(input.partyId, proposal.productLines, manual);
    await deps.markProposal(proposal.id, "applied");
    return { status: "applied" as const };
  } catch (error) {
    const message = error instanceof CartReadBackError ? error.message : publicFailure;
    await deps.markProposal(proposal.id, "failed", message);
    throw new Error(message);
  }
}
