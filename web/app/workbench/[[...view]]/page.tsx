import { WorkbenchView } from "@/components/native/WorkbenchView";

export default async function WorkbenchPage({ params }: { params: Promise<{ view?: string[] }> }) {
  const { view } = await params;
  return <WorkbenchView view={view ?? []} />;
}
