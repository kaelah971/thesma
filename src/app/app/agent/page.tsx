import type { Metadata } from "next";
import SupplyAgentPanel from "@/components/agent/SupplyAgentPanel";

export const metadata: Metadata = { title: "Supply agent" };

export default function AgentPage() {
  return <SupplyAgentPanel />;
}
