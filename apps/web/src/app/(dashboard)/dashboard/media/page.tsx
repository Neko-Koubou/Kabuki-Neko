/**
 * S08 `/dashboard/media` (SA §1.2, Design §4.4; TASK-141): the creator's media library inside the
 * dashboard shell. The URL search parameters (`type`, `search`, `page`) are handed to the client
 * library as plain strings, which parses and clamps them, so the list state survives back/forward
 * navigation and reloads.
 */
import { AssetLibraryRoute } from "@/components/media/asset-library-picker-upload";

/** Search params as Next passes them to pages. */
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** First value of a search parameter. */
function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Media library page. */
export default async function MediaPage({ searchParams }: { searchParams: SearchParams }) {
  const raw = await searchParams;
  const params = Object.fromEntries(
    (["type", "search", "page"] as const).flatMap((name) => {
      const value = first(raw[name]);
      return value === undefined ? [] : [[name, value]];
    }),
  );
  return <AssetLibraryRoute params={params} />;
}
