import { redirect } from 'next/navigation'

type Search = Record<string, string | string[] | undefined>

function first(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] || ''
  return typeof value === 'string' ? value : ''
}

export default async function CreateRedirectPage({
  searchParams,
}: {
  searchParams?: Promise<Search>
}) {
  const params: Search = await (searchParams ?? Promise.resolve({}))
  const asset = first(params.asset) || first(params.library)
  const query = new URLSearchParams()
  if (asset) query.set('library', asset)
  redirect(query.size ? `/home?${query.toString()}` : '/home')
}
