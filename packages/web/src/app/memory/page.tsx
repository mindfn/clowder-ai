import { MemoryEntry } from '@/components/memory/page/MemoryEntry';

export default function MemoryPage({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const from = typeof searchParams.from === 'string' ? searchParams.from : null;
  const requested = searchParams.tab;
  const tab = requested === 'brakes' || requested === 'library' || requested === 'recall' ? requested : 'all';
  return <MemoryEntry tab={tab} from={from} />;
}
