# Kabuki Neko

Kabuki Neko is a self-hostable live quiz game: a host runs a quiz on a shared screen and players
join from their phones with a room code or QR code.

## Self-hosting with Docker

Start here: **[docs/self-hosting.md](docs/self-hosting.md)** (Bahasa Indonesia + English):
requirements, configuration, the default and scale profiles, optional automatic HTTPS
(`docker/docker-compose.tls.yml`), data locations, upgrades, backups, troubleshooting and limits.

```bash
cp .env.example docker/.env
docker compose -f docker/docker-compose.yml up -d --build
# then open http://localhost:3000/setup
```

Check an installation with `bash scripts/selfhost-smoke.sh` (isolated project, never touches
your data).

## Documentation

| Topic                                  | Document                                                   |
| -------------------------------------- | ---------------------------------------------------------- |
| Compose profiles, secrets, TLS details | [docs/deployment.md](docs/deployment.md)                   |
| Backup, restore, recovery limits       | [docs/operations.md](docs/operations.md)                   |
| Browser security headers               | [docs/security-headers.md](docs/security-headers.md)       |
| Languages and translation packages     | [docs/localization.md](docs/localization.md)               |
| Measured capacity and budgets          | [docs/performance-results.md](docs/performance-results.md) |
| Release evidence and open gaps         | [docs/release-checklist.md](docs/release-checklist.md)     |

## Audio rights

The distribution rights of the bundled music are **not verified yet**
([docs/audio-provenance.json](docs/audio-provenance.json), `release-unverified`). Do not
redistribute builds publicly until that status is `cleared`.

## License

Code: [LICENSE](LICENSE) (Apache-2.0 with Commons Clause). Third-party components and assets:
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). The code license does not apply to the audio.
