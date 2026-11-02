import type { Metadata } from "next";
import { DeveloperShell } from "@/components/build/DeveloperShell";
import { getDeveloperContext } from "./data";

export const metadata: Metadata = { title: { default: "Build with Thesma", template: "%s · Build with Thesma" } };

export default async function BuildLayout({ children }: { children: React.ReactNode }) {
  const context = await getDeveloperContext();
  return <DeveloperShell context={context}>{children}</DeveloperShell>;
}
