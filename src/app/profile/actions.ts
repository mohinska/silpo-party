"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { agentV2Enabled } from "@/lib/ai/agents/agent-version";

export async function savePreferences(formData: FormData) {
  const user = await requireUser();
  const supabase = await createClient();
  const text = (name: string) => String(formData.get(name) ?? "").trim().slice(0, 1000);
  if (agentV2Enabled()) {
    const { error } = await supabase.rpc("agent_v2_update_profile", {
      p_allergies: text("allergies"),
      p_dietary_restrictions: text("dietary_restrictions"),
      p_dislikes: text("dislikes"),
      p_preferences: text("preferences"),
    });
    if (error) throw new Error("Не вдалося зберегти профіль.");
    revalidatePath("/profile");
    return;
  }
  const { error } = await supabase.from("profiles").upsert({
    id: user.id,
    allergies: text("allergies"),
    dietary_restrictions: text("dietary_restrictions"),
    dislikes: text("dislikes"),
    preferences: text("preferences"),
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error("Не вдалося зберегти профіль.");
  revalidatePath("/profile");
}
