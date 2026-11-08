# Localization guide

Kabuki Neko ships its user interface in six built-in languages (`en`, `id`, `ja`, `zh-Hans`, `es`, `fr`) and can be extended with additional languages through **declarative source packages**. A package is plain JSON data — it is validated and compiled when the application is built, never executed and never uploaded to a running server.

## Package layout

```text
extensions/locales/<tag>/
  manifest.json
  common.json  auth.json  quizzes.json  studio.json  media.json  host.json
  player.json  reports.json  admin.json  validation.json  accessibility.json  about.json
```

`<tag>` is a canonical BCP 47 tag (for example `de`, `pt-BR`, `zh-Hant`) and must equal `manifest.locale`. Built-in packages live in `packages/shared/locales/<tag>/` and use the same format.

`manifest.json`:

```json
{
  "schemaVersion": 1,
  "locale": "de",
  "nativeName": "Deutsch",
  "direction": "ltr",
  "packageVersion": "1.0.0",
  "catalogVersion": "1",
  "credits": [{ "name": "Kabuki Neko contributors", "url": null }]
}
```

Each namespace file is a flat object of stable keys to ICU MessageFormat strings:

```json
{
  "greeting": "Hallo {name}",
  "items": "{count, plural, one {# Frage} other {# Fragen}}"
}
```

Rules enforced by the validator (see `packages/shared/locales/message-contracts.json` for every key, its description and its placeholders):

- Only declared keys are allowed; duplicate JSON keys are rejected with their line and column.
- Every placeholder of the contract must appear with the declared kind (`string`, `number` via `number`/`plural`, `date` via `date`/`time`) and no other placeholder may be added.
- `plural` and `select` need an `other` branch; nesting is limited to 5 levels and 200 AST nodes per message.
- HTML/XML markup and ICU rich-text tags are not allowed. Links are rendered by the application around the text.
- Messages are 1–4000 code points; a namespace file is at most 256 KiB and a package at most 2 MiB.
- Symbolic links and any file other than `manifest.json` and the twelve namespace files are rejected without being read.

Built-in packages must be 100% complete with no warnings. External packages may be partial: each missing key is reported as a warning and falls back to English at runtime. The package `coverage` is shown in the language picker.

## Adding a language

1. Scaffold the package from the English source (the target must be a new directory inside the repository):

   ```bash
   pnpm locales:template --locale de --out extensions/locales/de
   ```

   Translators without a checkout can download the same template as `/locales/template-v1.zip` from the published web app; copy it to `extensions/locales/<tag>/` and edit `manifest.json` (`locale` is `und` in the ZIP and must be replaced).

2. Translate the values. Keep keys and `{placeholders}` unchanged.
3. Validate just this package, optionally one namespace at a time:

   ```bash
   pnpm locales:validate --locale de
   ```

   ```bash
   pnpm locales:validate --locale de --namespaces player,host
   ```

4. Build the catalog bundle and the application, then restart **both** the web and API containers so they serve the same `buildId`:

   ```bash
   pnpm locales:build
   ```

   ```bash
   pnpm build
   ```

`pnpm locales:validate` without flags checks every built-in and external package and all twelve namespaces; this is the release gate.

## What the build produces

`pnpm locales:build` writes `locales-built/` (or `--out <dir>`):

- `<buildId>/<tag>/<namespace>.json` — compiled ICU ASTs, content-addressed and immutable;
- `registry.json` — `{ buildId, catalogVersion: "1", locales: LocaleEntry[] }` with the SHA-256 and URL `/locales/<buildId>/<tag>/<namespace>.json` of every namespace;
- `template-v1.zip` — the translator template.

The same `buildId` is consumed by the API (`GET /system/locales`) and the web app; startup refuses mismatched artifacts. Hashes and `buildId` are deterministic for identical sources.

If any package has an error, the build stops **before writing anything**, so the installed bundle keeps serving. A successful build is staged in a temporary directory, moved into place, and only then is `registry.json` replaced atomically. The previous build directory is kept for rollback; older ones are pruned.

## Rollback and removal

- **Rollback:** redeploy the previous web/API image pair together with the previous source package (or restore the previous `registry.json`, whose build directory is retained). Always roll back both containers together.
- **Removing a language:** delete `extensions/locales/<tag>/`, rebuild and restart. Browsers that had selected the removed locale fall back on their next visit (explicit preference, then `Accept-Language`, then the instance default, then English).

## Not supported by design

- No runtime upload or hot reload of language packages and no remote contribution API. Visitors of a shared installation send packages to the maintainer, who installs them through this source workflow.
- No implicit override: an external package with the same tag as a built-in or another external package is rejected (`DUPLICATE_LOCALE`).
- Reserved pseudo-locales (`en-XA`, `ar-XB`) are rejected unless a test build passes `--allow-pseudo`.

## Diagnostic codes

| Code                   | Meaning                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `INVALID_MANIFEST`     | Malformed JSON (incl. duplicate keys), invalid manifest fields, unexpected/linked files or a missing built-in `en` |
| `DUPLICATE_LOCALE`     | Two packages declare the same tag                                                                                  |
| `UNKNOWN_KEY`          | Key not present in the message contracts                                                                           |
| `MISSING_KEY`          | Required key absent (error for built-ins, warning for external packages)                                           |
| `PLACEHOLDER_MISMATCH` | Placeholder names or kinds differ from the contract                                                                |
| `INVALID_ICU`          | ICU syntax error, missing `other`, nesting/size limit or forbidden characters                                      |
| `FORBIDDEN_MARKUP`     | HTML/XML markup or rich-text tags                                                                                  |
| `PACKAGE_TOO_LARGE`    | Message, namespace or package size limit exceeded                                                                  |
| `INCOMPATIBLE_VERSION` | `catalogVersion` is not `"1"`                                                                                      |
