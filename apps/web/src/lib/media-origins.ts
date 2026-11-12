/**
 * Public origins that may serve uploaded media to the browser (code review MJ-24).
 *
 * The API returns absolute media URLs: `${NEXT_PUBLIC_API_URL}/uploads/<key>` for local storage
 * and `${S3_PUBLIC_URL}/<key>` for S3. The browser therefore needs both origins:
 * - the API origin (`NEXT_PUBLIC_API_URL`);
 * - every public media base in `NEXT_PUBLIC_MEDIA_ORIGINS` (comma-separated URLs or origins, e.g.
 *   the S3/MinIO public URL). Paths are ignored, only origins count.
 * Both values are public build-time variables, inlined by Next. The same list feeds the client
 * URL allowlist of MediaPreview and the page CSP `img-src`/`media-src` (proxy.ts), so the two
 * never disagree. Only http(s) origins are kept.
 */

/** The http(s) origin of `value`, or null when it is not an absolute http(s) URL. */
export function httpOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

/** Origins from a comma-separated list of URLs or origins (invalid entries dropped). */
export function originList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => httpOrigin(entry.trim()))
    .filter((origin): origin is string => origin !== null);
}

/**
 * Origins allowed for absolute media URLs in this build: the API origin plus the configured
 * public media origins, de-duplicated. Read at call time so tests can stub the environment.
 */
export function publicMediaOrigins(): string[] {
  return [
    ...new Set(
      [
        httpOrigin(process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001"),
        ...originList(process.env.NEXT_PUBLIC_MEDIA_ORIGINS),
      ].filter((origin): origin is string => origin !== null),
    ),
  ];
}
