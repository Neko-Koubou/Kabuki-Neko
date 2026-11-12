# Operations: backup, restore and running Kabuki Neko

This guide covers what to back up, how to restore it, and the limits of recovery (SA §10.3; US-15,
US-16, US-17, US-20). The commands below are exercised by
`tests/integration/backup-restore.spec.ts` for SQLite, PostgreSQL and MySQL. The test checks that
the commands it runs appear here verbatim.

Compose examples use `C="docker compose -f docker/docker-compose.yml"` (add `--profile scale` for
the scale profile).

## What a backup contains

A usable backup is **all four parts from the same point in time**:

| Part                  | Default profile                            | Scale profile                                            |
| --------------------- | ------------------------------------------ | -------------------------------------------------------- |
| SQL database          | `kabuki-data` volume, `kabuki-neko.sqlite` | PostgreSQL `kabuki` (or your MySQL)                      |
| Media blobs           | `kabuki-uploads` volume                    | MinIO bucket `kabuki-neko-media` (`kabuki-minio` volume) |
| Generated secrets     | `kabuki-data/runtime-secrets.json` (0600)  | `kabuki-secrets` volume                                  |
| Storage origin ledger | `kabuki-data/storage-origins/`             | `kabuki-data/storage-origins/`                           |

The database holds the media references: questions, covers and report snapshots name each media
row. The blobs hold the bytes; uploaded keys are immutable and never overwritten. The secrets sign
existing sessions. The ledger pins each storage origin's identity: the API refuses to start if a
restored origin's path or public URL differs.

**Consistency.** The safest backup stops the API first (`$C stop api`), so nothing writes. For an
online backup, take the **database first and the blobs second**, and do not run the storage
cleanup in between. Every blob referenced by the database snapshot already exists and is never
modified; extra blobs uploaded afterwards are harmless orphans that the next cleanup removes.

## Database

### SQLite (default profile)

Never copy a live SQLite file and its `-wal` side file by hand. Use SQLite's online backup API,
which produces a consistent copy while the API keeps running:

```bash
$C exec -T api node -e 'const {createRequire}=require("node:module");const Database=createRequire(require.resolve("@kabuki-neko/database"))("better-sqlite3");new Database(process.env.SQLITE_PATH,{readonly:true}).backup(process.argv[1]).then(()=>console.log("sqlite backup complete"))' /app/data/backup.sqlite
$C cp api:/app/data/backup.sqlite ./backup/kabuki-neko.sqlite
```

Restore with the API stopped: replace the database and delete the old WAL side files.

```bash
$C stop api
$C cp ./backup/kabuki-neko.sqlite api:/app/data/kabuki-neko.sqlite
$C run --rm --no-deps --entrypoint sh api -c 'rm -f /app/data/kabuki-neko.sqlite-wal /app/data/kabuki-neko.sqlite-shm'
$C start api
```

### PostgreSQL (scale profile)

```bash
$C exec -T postgres pg_dump -U kabuki -d kabuki --format=custom --file=/tmp/kabuki.pgdump
$C cp postgres:/tmp/kabuki.pgdump ./backup/kabuki.pgdump
```

Restore with the API stopped. `--clean --if-exists` replaces every object of the dump:

```bash
$C stop api
$C cp ./backup/kabuki.pgdump postgres:/tmp/kabuki.pgdump
$C exec -T postgres pg_restore -U kabuki -d kabuki --clean --if-exists --no-owner /tmp/kabuki.pgdump
$C start api
```

### MySQL 8.4 (external)

Pass the password through `MYSQL_PWD`, never on the command line:

```bash
MYSQL_PWD=<password> mysqldump --single-transaction --routines --triggers --no-tablespaces -u kabuki --result-file=/tmp/kabuki.sql kabuki
```

Restore with the API stopped (the dump drops and recreates each table):

```bash
MYSQL_PWD=<password> mysql -u kabuki kabuki -e "source /tmp/kabuki.sql"
```

## Media blobs, secrets and the ledger

Default profile: archive the uploads and the data volume (secrets and ledger) with the API
stopped, or right after the database backup:

```bash
docker run --rm -v kabuki-neko_kabuki-uploads:/data:ro -v "$PWD/backup":/backup busybox tar -czf /backup/uploads.tgz -C /data .
docker run --rm -v kabuki-neko_kabuki-data:/data:ro -v "$PWD/backup":/backup busybox tar -czf /backup/data.tgz -C /data runtime-secrets.json storage-origins
```

Restore by extracting into the same volumes with the API stopped. Archives keep ownership (uid 10001) and modes (0600 for the secrets file).

Scale profile: stop `minio` and archive the `kabuki-minio` volume the same way, or copy the bucket
with any S3 client. Archive the `kabuki-secrets` volume with the other parts.

Treat backups like the secrets they contain: encrypt them at rest and restrict who can read them.

## Restore checklist and session policy

1. Stop the API (`$C stop api`), keep the web running or show a maintenance page.
2. Restore the database, the blobs, `runtime-secrets.json` and `storage-origins/` from **one**
   backup. Restore storage to the same path and public URL, or start with
   `STORAGE_LOCATIONS_FILE` listing the old origin (see below).
3. Start the API and check `/api/v1/system/health` and a quiz with media.

What happens to sign-ins:

- Access tokens are signed with the restored secrets. Tokens issued before the backup point keep
  working until they expire (15 minutes).
- Refresh sessions created **after** the backup point do not exist in the restored database, so
  those browsers are asked to sign in again. Sessions revoked after the backup point are active
  again until they expire. If that matters, or the backup or its secrets may have leaked, also
  rotate the secrets:
  - default profile: delete `runtime-secrets.json` before starting;
  - scale profile, or explicit secrets: set new `JWT_ACCESS_SECRET`/`JWT_REFRESH_SECRET`.

  Everyone then signs in again.

## Changing drivers, profiles or the state namespace

- **No implicit data transfer.** Changing `DB_DRIVER`, `STORAGE_DRIVER`, `STATE_DRIVER` or the
  Compose profile points the API at another empty store. It never copies data. An instance
  switched from SQLite to PostgreSQL starts as a new, uninitialized instance. Migrate deliberately:
  export quizzes, or move the SQL and blobs with the procedures above, before switching.
- **Draining.** Before restarting or switching, wait until no game is running, or end games from
  the host screen; games in progress are not migrated. Changing `STATE_NAMESPACE` on a shared
  Redis has the same effect as a new, empty game-state store.

## Recovery limits

- **In-memory games (default profile)** do not survive a restart, recreate or restore. Their
  rooms are reported "lost", and no result is invented for them.
- **Redis** uses AOF with `appendfsync everysec`: a crash or failover can lose up to about one
  second of game-state writes. Recovery is checked against the authoritative state. While the
  state store is uncertain, players and hosts are locked and resynchronize, and private answers
  are never revealed from a cache. It is not zero-loss.
- **Finished reports** are written to SQL through the finalization queue and survive restarts.
  - A failed write is retried with backoff.
  - The host sees "The report couldn't be saved" with **Try saving again** (`POST
/api/v1/reports/:id/retry-finalize`).
  - A report still not durable 24 hours after its game logs one error-level line, `finalization
pending for more than 24 h for session <id>`, and the room is kept until the report is saved.
- **Storage origins.** If uploads moved (new path, bucket or public URL), list the previous origin
  in a JSON array file named by `STORAGE_LOCATIONS_FILE`:
  - local entries: `{ "id", "driver": "local", "path", "publicUrl" }`;
  - S3 entries: `{ "id", "driver": "s3", "endpoint", "region", "bucket", "forcePathStyle",
"publicUrl", "accessKeyEnv", "secretKeyEnv" }`. The last two name environment variables
    that hold the keys; never write the keys into the file.

  Existing media then keeps resolving from its recorded origin. Media whose origin is missing is
  reported unavailable, never silently re-pointed.

## Retention and logs

- **Audit events** are kept `AUDIT_RETENTION_DAYS` days (default 30, allowed 7–365) and pruned
  automatically.
- **Application logs** go to stdout and stderr without passwords, tokens, cookies or invite
  codes. Keep them **14 days** with your log driver, for example in Compose:
  `logging: { driver: json-file, options: { max-size: "50m", max-file: "14" } }` with daily
  rotation in your collector, or journald retention of 14 days.

## Capacity and network limits

- `MAX_ACTIVE_ROOMS` caps concurrent rooms: 20 per process with memory state, 200 per instance
  with Redis, configurable from 1 to 10000. At the limit, new rooms get `503 CAPACITY_REACHED`.
  This is a protective limit, not a measured capacity.
- **Joining behind NAT.** PIN checks and joins share a budget of **10 per minute per client
  address**. A classroom behind one NAT address shares that budget, so let players join in waves,
  or put the instance behind your own reverse proxy and list it in `TRUST_PROXY_CIDRS` so
  forwarded addresses count separately. Never trust addresses from outside your proxy.
