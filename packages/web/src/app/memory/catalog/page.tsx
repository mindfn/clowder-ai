import { redirect } from 'next/navigation';

export default function MemoryCatalogPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const from = typeof searchParams.from === 'string' ? `?from=${encodeURIComponent(searchParams.from)}` : '';
  redirect(`/memory${from}`);
}
