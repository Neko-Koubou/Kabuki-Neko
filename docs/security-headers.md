# Browser security headers

Kabuki Neko sends strict browser security headers from both servers (SA §10.1). This page explains
what each server sends, what a deployment must add, and how to allow extra media origins.

## Web app (Next.js)

`apps/web/src/proxy.ts` runs before every page and sends a fresh nonce-based
`Content-Security-Policy`:

| Directive                 | Value                                                              | Why                                                                                                                  |
| ------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `script-src`              | `'self' 'nonce-…' 'strict-dynamic'`                                | Only Next's own nonce-stamped scripts run. No `unsafe-eval` and no `unsafe-inline` in production.                    |
| `style-src`               | `'self' 'unsafe-inline'`                                           | React renders `style` attributes. CSS cannot execute scripts.                                                        |
| `img-src`, `media-src`    | `'self' blob: data:` + API origin + `CSP_MEDIA_ORIGINS`            | Uploaded media comes from the API's `/uploads` (or a public bucket). Avatars and local previews use `data:`/`blob:`. |
| `connect-src`             | `'self'` + API and WebSocket origins (http/ws and https/wss forms) | REST and the game socket.                                                                                            |
| `frame-src`               | `https://www.youtube-nocookie.com`                                 | Privacy-enhanced YouTube embeds only.                                                                                |
| `object-src`              | `'none'`                                                           | No plugins.                                                                                                          |
| `base-uri`, `form-action` | `'self'`                                                           | No base-tag or form hijacking.                                                                                       |
| `frame-ancestors`         | `'self'`                                                           | The app cannot be framed by other sites.                                                                             |

Every response, including static files, also gets:

- `X-Content-Type-Options: nosniff`;
- `Referrer-Policy: strict-origin-when-cross-origin`;
- `Permissions-Policy: camera=(self), microphone=(), geolocation=(), payment=(), usb=()`. The camera
  is allowed only for the QR join scanner.

### Extra media origins

When uploads are served from a public S3 bucket or CDN instead of the API, list the origin(s) in
`CSP_MEDIA_ORIGINS` for the **web** container. Separate several origins with commas, for example
`CSP_MEDIA_ORIGINS=https://media.example.com`. The value is read at runtime and is not a public build
variable.

## API (NestJS)

`apps/api/src/main.ts` adds the following to every API response:

- `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; sandbox`: a JSON, CSV or
  uploaded file opened directly loads and runs nothing;
- `X-Frame-Options: DENY`;
- `Referrer-Policy: strict-origin-when-cross-origin`;
- `Cross-Origin-Resource-Policy`: `cross-origin` for `/uploads/*` (the web app embeds them),
  `same-site` for everything else.

Uploads are served only with their allowlisted MIME type, `X-Content-Type-Options: nosniff`, and
storage keys resolved inside the configured root.

## HTTPS and HSTS (deployment)

The app servers speak plain HTTP inside your network. Terminate TLS at the reverse proxy in front of
them, and send HSTS **from that proxy**:

```nginx
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
```

```caddyfile
header Strict-Transport-Security "max-age=31536000; includeSubDomains"
```

Only enable HSTS once HTTPS works for the whole domain, because browsers remember it for the full
`max-age`. Keep `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_WS_URL` and `NEXT_PUBLIC_APP_URL` on `https://`
so the CSP allows exactly those origins.

## Redirects

Sign-in `returnTo` values and scanned QR codes only lead to local app paths. Other origins,
protocol-relative URLs and auth pages fall back to the dashboard or the join page.
