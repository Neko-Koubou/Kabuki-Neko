# Driver verification

What each adapter combination was verified against, how to re-run it, and what is still
unverified (SA §11.2; US-06, US-16, US-17). Evidence of the latest run is written to
`test-results/driver-verification/` (not committed). This page records the run the release
evidence refers to.

## Scope

Kabuki Neko has three adapters:

| Adapter                          | Choices                                                     |
| -------------------------------- | ----------------------------------------------------------- |
| Database (`DB_DRIVER`)           | SQLite (bundled `better-sqlite3`), PostgreSQL 16, MySQL 8.4 |
| Game state (`STATE_DRIVER`)      | in-process memory, Redis 7                                  |
| Media storage (`STORAGE_DRIVER`) | local disk, S3 API                                          |

### Single node

All 3 × 2 × 2 = 12 combinations are valid on one API process. `tests/contracts/driver-matrix.spec.ts`
gives each combination a fresh runtime, with real engines in containers and the built API. It
checks that:

1. health reports exactly the configured drivers, all `up`;
2. first-run setup and host registration succeed;
3. an uploaded image is re-encoded to WebP and can be read back from the configured storage
   (over HTTP for local disk, through the S3 API for the bucket);
4. a quiz that uses the image can be saved;
5. a game over Socket.IO, with a correct answer and then End game, works;
6. the durable report becomes `ready` with the player's answer recorded as `ANSWERED`/`CORRECT`.

### Multi node

`DEPLOYMENT_TOPOLOGY=multi` is valid only with all three of:

- an external database (PostgreSQL or MySQL);
- Redis;
- storage every node reaches: S3, or local disk explicitly marked `LOCAL_STORAGE_SHARED=true`.

The matrix runs two API processes per external database, with Redis and the S3 API:

- the host is connected to node A;
- the player and the upload go to node B.

It also checks that SQLite, memory state and unshared local storage are refused at startup in this
topology.

### Hosted object storage

The S3 tests above run against MinIO. **MinIO proves the S3 protocol path; it does not certify any
hosted provider.** `tests/contracts/cloud-storage.spec.ts` runs a smoke test against each provider
independently, only with credentials an operator supplies:

| Provider            | Variables (`<P>`)       |
| ------------------- | ----------------------- |
| Amazon S3           | `KABUKI_CLOUD_AWS_S3_*` |
| Cloudflare R2       | `KABUKI_CLOUD_R2_*`     |
| DigitalOcean Spaces | `KABUKI_CLOUD_SPACES_*` |

Each provider needs `ENDPOINT`, `REGION`, `BUCKET`, `ACCESS_KEY`, `SECRET_KEY` and `PUBLIC_URL`, and
optionally `FORCE_PATH_STYLE=true`. Use a dedicated test bucket whose objects are publicly readable
at `PUBLIC_URL`.

The smoke test checks:

- the production write options;
- refusal to overwrite an immutable key;
- the exact size on head;
- public read with content type and immutable caching;
- the health probe;
- idempotent delete;
- a wrong secret reported as `down`.

A provider without credentials is recorded as **NOT RUN** and its test is skipped. It is never
reported as passed, and no stand-in endpoint is substituted.

## How to run

```bash
pnpm --filter "@kabuki-neko/api..." build
pnpm test:contracts --runInBand --runTestsByPath tests/contracts/driver-matrix.spec.ts
# With operator-supplied test credentials, e.g. KABUKI_CLOUD_R2_ENDPOINT=..., per provider:
pnpm test:contracts --runInBand --runTestsByPath tests/contracts/cloud-storage.spec.ts
```

The matrix needs Docker for the PostgreSQL, MySQL, Redis and MinIO containers. MinIO is built
from pinned upstream source the first time (`git fetch` and the Go module downloads need the
network).

Two ways to get MinIO where that build cannot reach the network directly:

- **Behind a TLS-intercepting proxy:** set `KABUKI_TEST_BUILD_CA` to the proxy's CA certificate
  (PEM).

  ```bash
  KABUKI_TEST_BUILD_CA=/path/to/proxy-ca.pem pnpm test:contracts --runInBand \
    --runTestsByPath tests/contracts/driver-matrix.spec.ts
  ```

  The build stage trusts it only for the fetch and build step, through a temporary bundle that
  is deleted in the same step. The image copies the untouched distro bundle, so the proxy CA is
  never in it. The image tag carries the CA's digest (`…-go1.27.3-ca<sha256 prefix>`), so it never
  shares a cache entry with an image built without it.

- **No network at all:** set `KABUKI_TEST_MINIO_IMAGE` to a prebuilt image of the same pinned
  source. It wins over `KABUKI_TEST_BUILD_CA`.

The Compose scale profile builds the same source. Pass the proxy CA as the optional BuildKit
secret `build_ca` through `KN_BUILD_CA_FILE` (default `/dev/null`, meaning none). It is mounted
for the fetch and build step only, and is never stored in a layer:

```bash
KN_BUILD_CA_FILE=/path/to/proxy-ca.pem docker compose -f docker/docker-compose.yml --profile scale build minio
```

## Latest recorded run

Run on 2026-11-11 (UTC), Node.js v26.13.0, Linux x86_64 with Docker. Every single-node and
multi-node combination **passed**.

### Engine versions

| Service    | Image                                                                                  | Reported version |
| ---------- | -------------------------------------------------------------------------------------- | ---------------- |
| SQLite     | bundled `better-sqlite3`                                                               | 3.53.2           |
| PostgreSQL | `postgres:16-alpine`                                                                   | 16.15            |
| MySQL      | `mysql:8.4`                                                                            | 8.4.13           |
| Redis      | `redis:7-alpine`                                                                       | 7.4.12           |
| S3 API     | MinIO built from pinned commit `9e49d5e7a648` (prebuilt image with the local proxy CA) | —                |

### Single node (12/12)

| Database | State  | Storage | Result | Duration |
| -------- | ------ | ------- | ------ | -------- |
| sqlite   | memory | local   | PASS   | 9.4 s    |
| sqlite   | memory | s3      | PASS   | 11.1 s   |
| sqlite   | redis  | local   | PASS   | 9.9 s    |
| sqlite   | redis  | s3      | PASS   | 10.9 s   |
| postgres | memory | local   | PASS   | 11.7 s   |
| postgres | memory | s3      | PASS   | 13.0 s   |
| postgres | redis  | local   | PASS   | 12.4 s   |
| postgres | redis  | s3      | PASS   | 13.4 s   |
| mysql    | memory | local   | PASS   | 18.2 s   |
| mysql    | memory | s3      | PASS   | 20.5 s   |
| mysql    | redis  | local   | PASS   | 18.2 s   |
| mysql    | redis  | s3      | PASS   | 19.2 s   |

### Multi node (2 API processes)

| Combination                | Result | Duration |
| -------------------------- | ------ | -------- |
| postgres/redis/s3 ×2 nodes | PASS   | 15.7 s   |
| mysql/redis/s3 ×2 nodes    | PASS   | 21.4 s   |

| Invalid multi-node configuration | Result                    |
| -------------------------------- | ------------------------- |
| SQLite                           | refused at startup (PASS) |
| memory state                     | refused at startup (PASS) |
| unshared local storage           | refused at startup (PASS) |

### Hosted object storage

| Provider            | Status                                                |
| ------------------- | ----------------------------------------------------- |
| Amazon S3           | **NOT RUN, unverified**: no test credentials supplied |
| Cloudflare R2       | **NOT RUN, unverified**: no test credentials supplied |
| DigitalOcean Spaces | **NOT RUN, unverified**: no test credentials supplied |

Until an operator runs `cloud-storage.spec.ts` with real test credentials for a provider, that
provider is unverified. Only the generic S3 protocol path is proven, by MinIO. The test's own
configured path was exercised once against a throwaway MinIO bucket so that the smoke test is known
to work. That run is not provider evidence and is not recorded above.
