import { UnifiedLibraryView } from '@/components/native/UnifiedLibraryView';

export default async function LibraryPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const query = await searchParams;
  return <UnifiedLibraryView view={query.view === 'outputs' ? 'outputs' : 'files'} />;
}
