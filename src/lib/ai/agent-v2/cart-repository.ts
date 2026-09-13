import "server-only";
import { z } from "zod";
import { createAdminClient } from "../../supabase/admin";
import { RepositoryError, type RpcTransport } from "./repository";
import { CartOperationSchema, type CartOperationRepository } from "./cart-reconciliation";

export function createCartOperationRepository(transport?: RpcTransport): CartOperationRepository {
  const rpc = transport ?? ((name, args) => createAdminClient().rpc(name, args));
  async function call(name: string, args: Record<string, unknown>) {
    const result = await rpc(name, args);
    if (result.error) throw new RepositoryError(result.error.message, result.error.code);
    return result.data;
  }
  return {
    async acquire(input) { return CartOperationSchema.parse(await call("agent_v2_cart_acquire", { p_operation_id: z.uuid().parse(input.operationId), p_actor_id: z.uuid().parse(input.actorId), p_worker_id: z.string().min(1).parse(input.workerId), p_cart_id: z.string().min(1).parse(input.cartId) })); },
    async prepare(input) { await call("agent_v2_cart_prepare", { p_operation_id: z.uuid().parse(input.operationId), p_worker_id: z.string().min(1).parse(input.workerId), p_baseline: input.baseline, p_expected_cart: input.expectedCart, p_changes: input.changes }); },
    async finish(input) { await call("agent_v2_cart_finish", { p_operation_id: z.uuid().parse(input.operationId), p_worker_id: z.string().min(1).parse(input.workerId), p_status: z.enum(["verified", "failed", "unknown"]).parse(input.status), p_readback: input.readback, p_private_error: input.privateError ?? null }); },
    async read(operationId, actorId) {
      const admin = createAdminClient();
      const { data, error } = await admin.from("party_cart_operations").select("*").eq("id", z.uuid().parse(operationId)).single();
      if (error) throw new RepositoryError(error.message, error.code);
      const operation = CartOperationSchema.parse(data);
      const party = await admin.from("parties").select("host_id").eq("id", operation.party_id).single();
      if (party.error || party.data.host_id !== z.uuid().parse(actorId) || operation.approved_by !== actorId) throw new RepositoryError("Host authority required");
      return operation;
    },
  };
}
