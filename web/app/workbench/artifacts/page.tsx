import { redirect } from 'next/navigation';

export default async function LegacyArtifactsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    if (Array.isArray(value)) value.forEach(item => query.append(key, item));
    else if (value !== undefined) query.set(key, value);
  }
  query.set('view', 'outputs');
  redirect(`/workbench/library?${query.toString()}`);
}
