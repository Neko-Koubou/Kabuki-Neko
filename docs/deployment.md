# Deployment with Docker Compose

Kabuki Neko ships two production images (`docker/Dockerfile.api`, `docker/Dockerfile.web`) and
one Compose file (`docker/docker-compose.yml`) with two profiles (SA §10.2; US-16, US-17).

| Profile | Services                                                                                    | Drivers selected by `DEPLOYMENT_PROFILE`    |
| ------- | ------------------------------------------------------------------------------------------- | ------------------------------------------- |
| default | `web`, `api`                                                                                | SQLite, in-memory game state, local uploads |
| scale   | `web`, `api`, `postgres` (16), `redis` (7, AOF), `minio` (S3), `secrets-init`, `minio-init` | PostgreSQL, Redis, S3                       |

## Commands

Default profile:

```bash
docker compose -f docker/docker-compose.yml up -d --build
```

Scale profile (both parts are required together):

```bash
pnpm deploy:scale
# runs exactly:
DEPLOYMENT_PROFILE=scale docker compose -f docker/docker-compose.yml --profile scale up -d --build
```

- `DEPLOYMENT_PROFILE=scale` makes the API choose the postgres/redis/s3 drivers.
- `--profile scale` starts the services those drivers need.
- The variable without the flag never falls back to SQLite: the API's startup gate waits for
  PostgreSQL (`KN_STARTUP_WAIT_SEC`, default 60 s) and then exits with an error.
- Validate without starting: `pnpm deploy:scale config --quiet`.
- Stop: `pnpm deploy:scale down`.
- The default profile through the wrapper: `pnpm exec tsx scripts/start-profile.ts default`.

The bundled MinIO talks plain HTTP inside the private Compose network. Production configuration
refuses HTTP S3 endpoints unless `ALLOW_INSECURE_LOCAL_HTTP=true`, so the wrapper sets it for the
scale profile when you have not set it yourself, and prints a notice. Every URL a browser uses
must still be HTTPS (see [TLS](#tls-reverse-proxy-cookies-and-sockets)).

## Configuration

Set these in the shell or in `docker/.env` (see the Compose section of `.env.example`):

| Variable                                      | Meaning                                            | Default                                   |
| --------------------------------------------- | -------------------------------------------------- | ----------------------------------------- |
| `KN_PUBLIC_URL`                               | Web origin as browsers see it                      | `http://localhost:3000`                   |
| `KN_API_PUBLIC_URL`                           | API origin as browsers see it (REST and Socket.IO) | `http://localhost:3001`                   |
| `KN_MEDIA_PUBLIC_URL`                         | Scale: public base URL of the media bucket         | `http://localhost:9000/kabuki-neko-media` |
| `KN_BIND_ADDRESS`                             | Host address the ports bind to                     | `127.0.0.1`                               |
| `KN_WEB_PORT`, `KN_API_PORT`, `KN_MEDIA_PORT` | Host ports                                         | 3000, 3001, 9000                          |
| `TRUST_PROXY_CIDRS`                           | Addresses of your reverse proxy (JSON array)       | `[]`                                      |
| `KN_IMAGE_TAG`                                | Tag for the built images                           | `local`                                   |

The web image inlines `KN_PUBLIC_URL`/`KN_API_PUBLIC_URL` at build time, so rebuild it
(`--build`) after changing them. Never use Compose service names in public URLs.

The driver overrides in `.env.example` stay commented, so the profile chooses the drivers.
Changing a profile or a driver **does not move data**: SQLite data, local uploads and in-memory
games are not copied to PostgreSQL, S3 or Redis, nor back. Migrate deliberately before switching.

## Data and secrets

| Volume                                            | Contents                                                                 |
| ------------------------------------------------- | ------------------------------------------------------------------------ |
| `kabuki-data`                                     | SQLite database, generated runtime secrets (0600), storage origin ledger |
| `kabuki-uploads`                                  | Local media (default profile)                                            |
| `kabuki-secrets`                                  | Scale credentials from `secrets-init`                                    |
| `kabuki-postgres`, `kabuki-redis`, `kabuki-minio` | Scale service data (Redis with AOF, `appendfsync everysec`)              |

- Default profile: the API generates its JWT secrets once into `kabuki-data/runtime-secrets.json`
  (mode 0600) and reuses them after restarts.
- Scale profile: `secrets-init` generates random credentials once and keeps them on later runs.
  These are:
  - the PostgreSQL password and the database URL;
  - the MinIO root user and password, used as the S3 keys;
  - one JWT pair shared by every API node.

  Each file is mode 0400 and owned by the only service user that reads it (API uid 10001, MinIO
  uid 65532, PostgreSQL's root entrypoint).

- No credential is in the Compose file, an image or `.env.example`, and nothing uses the
  `minioadmin` sample. To supply your own secrets, set `<NAME>_FILE` (Docker secrets) or the
  variable itself for `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `DATABASE_URL`, `REDIS_URL`,
  `S3_ACCESS_KEY` and `S3_SECRET_KEY`.
- Several API nodes (`DEPLOYMENT_TOPOLOGY=multi`) need the same JWT pair. The entrypoint refuses
  to start a multi-node API without it.

`minio-init` creates the `kabuki-neko-media` bucket and gives anonymous clients `s3:GetObject`
only. Uploaded media is readable by URL, but the bucket cannot be listed or written anonymously.

## TLS reverse proxy, cookies and sockets

Put a TLS-terminating reverse proxy in front of every published port and keep
`KN_BIND_ADDRESS=127.0.0.1` (or a private address).

- **HTTPS everywhere.** The web origin, the API origin and the public media URL must be HTTPS.
  The refresh cookie is `Secure` on HTTPS, and HSTS belongs to the proxy
  (docs/security-headers.md).
- **Same site.** The refresh cookie is `HttpOnly; SameSite=Lax; Path=/api/v1/auth`, so the web
  and API origins must be the same site. Use the same origin with path routing, or subdomains of
  one registrable domain (`quiz.example.org` and `api.quiz.example.org`). Set `TRUST_PROXY_CIDRS`
  to the proxy's addresses so rate limits see real client addresses.
- **Sockets.** Proxy WebSocket upgrades for `/socket.io/`. Clients fall back to HTTP long-polling,
  whose requests stay open up to the 25 s ping interval. Set the proxy's read/idle timeout to **at
  least 75 s**. With more than one API node, use **sticky sessions** (cookie or source-IP
  affinity) so a polling session stays on one node. Redis carries the room state and events
  between nodes.
- **Public media.** `KN_MEDIA_PUBLIC_URL` must be reachable by players' browsers: proxy it to
  MinIO, or use an external S3-compatible bucket. Media is served with immutable
  caching (images are re-encoded to WebP).

## Health and lifecycle

- The API container is healthy only when `/api/v1/system/health` answers 200, which means the
  database, game state and storage are all up. The web container checks `/legal/LICENSE.txt`.
- Both images run as uid 10001 under tini, and `docker stop` sends SIGTERM to node. The API drains
  through its shutdown hooks; allow `stop_grace_period` (30 s for the API).
- Startup order in the scale profile:
  1. `secrets-init`;
  2. PostgreSQL and Redis become healthy;
  3. `minio-init` prepares the bucket;
  4. the API starts and applies migrations under its lock (`DB_AUTO_MIGRATE=true`);
  5. the web app starts once the API is healthy.

## Upgrades, migrations and catalogs

- **Migrations.** Every API process applies pending migrations at startup under a database lock:
  a PostgreSQL advisory lock or a MySQL named lock, and SQLite's exclusive transaction. When
  several API containers start together, one applies the migrations while the others wait (at
  most 60 s, then they exit and are restarted) and find nothing left to do. Back up before
  upgrading (see [docs/operations.md](operations.md)).
- **Catalog pair.** The web and API images each carry the locale bundle from the same build.
  The web container's healthcheck is a readiness check: it reports healthy only when the buildId
  of its `/locales/registry.json` equals the API's `/system/locales` buildId. During a mismatched
  rollout, or while the API is unreachable, the web stays unhealthy, so do not route traffic to
  it.
- **Rollback.** Redeploy the previous matching pair of images. The running web becomes healthy
  again as soon as the API serves its buildId. An API whose bundle fails its hashes refuses to
  start, so a broken catalog never goes live.
- **What a restart keeps.** Accounts, quizzes, media, reports and the finalization queue live in
  the database and storage volumes and survive restarts and recreated containers. Games in
  memory state (default profile) do not: their rooms are reported lost after a restart. Redis
  state (scale profile) survives with AOF.

## Verification

These run the real images and Compose projects under unique names, and remove only their own
containers, networks and volumes:

```bash
pnpm test:integration --runInBand --runTestsByPath tests/integration/deployment.spec.ts
pnpm test:integration --runInBand --runTestsByPath tests/integration/catalog-deployment.spec.ts
```

They use `kabuki-neko-{api,web}:${KABUKI_TEST_IMAGE_TAG:-local}` (built when missing). Set
`KABUKI_TEST_MINIO_IMAGE` to reuse a MinIO image built from the same pinned source.
