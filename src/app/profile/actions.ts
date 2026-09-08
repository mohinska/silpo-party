"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export async function savePreferences(formData: FormData) {
  const user = await requireUser();
  const supabase = await createClient();
  const text = (name: string) => String(formData.get(name) ?? "").trim().slice(0, 1000);
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
