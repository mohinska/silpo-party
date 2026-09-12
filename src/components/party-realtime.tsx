"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";

export function PartyRealtime({ partyId }: { partyId: string }) {
  const router = useRouter();

  useEffect(() => {
    const supabase = createClient();
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      if (refreshTimer) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        router.refresh();
      }, 80);
    };
    const channel = supabase
      .channel(`party-workspace:${partyId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "party_chat_messages", filter: `party_id=eq.${partyId}` }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "agent_runs", filter: `party_id=eq.${partyId}` }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "ai_meal_proposals", filter: `party_id=eq.${partyId}` }, refresh)
      .subscribe();

    return () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      void supabase.removeChannel(channel);
    };
  }, [partyId, router]);

  return null;
}
