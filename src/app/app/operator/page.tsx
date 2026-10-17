import type { Metadata } from "next";
import { NoWorkspace } from "@/components/app/NoWorkspace";
import { OperatorWorkspace } from "@/components/app/OperatorWorkspace";
import { requireWorkspace } from "../data";

export const metadata: Metadata = { title: "Operator" };

export default async function OperatorPage() {
  const { session, snapshot } = await requireWorkspace();
  if (!snapshot || session.kind !== "ok") return <NoWorkspace />;
  const initials = (session.user.name ?? session.user.email).slice(0, 2).toUpperCase();
  return <OperatorWorkspace snapshot={snapshot} initials={initials} />;
}
