import { notFound } from "next/navigation";
import { HostedGrowthProgram } from "@/components/public/HostedGrowthProgram";
import { createProductionPublicGrowthProgramService } from "@/server/services/publicGrowthPrograms";

export default async function HostedGrowthProgramPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const program = await createProductionPublicGrowthProgramService().getProgramBySlug(slug, process.env.NEXT_PUBLIC_APP_URL ?? "https://thesma.vercel.app").catch(() => null);
  if (!program) notFound();
  return <HostedGrowthProgram program={program} />;
}
