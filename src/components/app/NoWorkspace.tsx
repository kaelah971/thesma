import { CreateWorkspaceForm } from "./CreateWorkspaceForm";
import { PageHeader, Card } from "./ui";

export function NoWorkspace() {
  return (
    <>
      <PageHeader eyebrow="Get started" title="Create your workspace" description="A workspace holds your company's campaigns, budget, outcomes and receipts. You'll be its owner." />
      <Card title="Company details">
        <CreateWorkspaceForm />
      </Card>
    </>
  );
}
