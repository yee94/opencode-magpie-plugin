# Release procedure

## Package boundaries

The root is a private pnpm workspace and is never published. The two public packages are independent and have no runtime npm dependencies:

| Package | Directory | Check | Tag |
| --- | --- | --- | --- |
| `opencode-magpie-plugin` | `packages/opencode-magpie-plugin` | `pnpm check:opencode` | `opencode-magpie-plugin/v<version>` |
| `magpie-claude-opencode-adapter` | `packages/magpie-claude-opencode-adapter` | `pnpm check:adapter` | `magpie-claude-opencode-adapter/v<version>` |

Each package owns its manifest, version, README, runtime, tests and npm file list. Shared development dependencies and publishing utilities live at the private root. A change to one package does not require changing the other's version.

## CI and CD contract

CI runs both package checks as independent matrix jobs plus a shared tooling job. `.github/workflows/release.yml` supports:

- **Run workflow → package: all**: publish both manifests' versions as two independent matrix jobs.
- **Run workflow → a package name**: publish only that package.
- **Push a package version tag**: publish only the matching package.
- **Legacy `v<version>` tag**: publish only `opencode-magpie-plugin`; its version is now in its own package manifest.

Each publish job checks the shared release helpers and its selected package, packs once with pnpm, checks whether the exact artifact is already public, publishes that tarball, verifies public npm metadata and creates that package's GitHub Release. `fail-fast: false` prevents one package's failure from cancelling the other. Releases are created inside the independent package job, not behind an aggregate success gate. Concurrency is serialized per package.

Manual runs create package-specific tags at the selected workflow commit when creating the GitHub Release. Tag-triggered runs require an exact version match. Stable package versions use npm `latest`; prereleases use `next` and GitHub prereleases. Build metadata (`+...`) is unsupported.

## Authentication

Repository Actions secret `NPM_TOKEN` is passed as `NODE_AUTH_TOKEN` only to the publish step. `actions/setup-node` supplies registry configuration. The token needs publish rights for each selected package, including permission to create a new package on first publication, and must permit unattended publishing under the npm account's 2FA policy.

A token that publishes the OpenCode package may still return 403 for the adapter. This is a credential blocker, not a reason to merge packages or weaken verification. Keep tokens out of repository files, logs and chat. GitHub Release creation uses `GITHUB_TOKEN` with `contents: write`.

## Publish

1. Inspect `git status`, fetch `origin/main`, and inspect each selected package's current public npm versions. Preserve unrelated work. Never reuse a published version for changed content, including README or manifest changes.
2. Change versions only in the selected `packages/*/package.json` files. Run `pnpm check` for the full workspace, or the selected package check plus `pnpm test:release` for a narrow release.
3. Pack each selected package with `pnpm --dir packages/<name> pack --pack-destination <temporary-directory>` (pnpm 9's `pack` does not support `--filter`). Inspect the contents: the OpenCode package exports its built `dist` entries; the adapter exports `adapter.middleware.js`; neither tarball contains the other package or runtime dependencies.
4. Commit and push to `main`, then publish both packages with:

   ```sh
   gh workflow run release.yml --ref main -f package=all
   ```

   To publish one, use `-f package=opencode-magpie-plugin` or `-f package=magpie-claude-opencode-adapter`. Alternatively, push its annotated package version tag. A branch push only runs CI, not npm publishing.
5. Follow the exact run with `gh run watch <run-id> --exit-status`. For each package, verify the exact version and dist-tag via public `https://registry.npmjs.org/`, and inspect its GitHub Release.

**Done:** each requested package's job is green; its public npm name/version/SHA-512 tarball integrity match the CI artifact; dependencies and optionalDependencies are empty; its intended dist-tag points to the expected version; its GitHub Release exists. Report both npm and GitHub URLs when releasing both. A pushed tag, successful build, accepted publish response, or one published package does not complete a two-package release.

## Recovery

- **npm processing delay:** verification allows up to five minutes for public metadata to appear. If still delayed, verify later and rerun; do not publish a different tarball over the same version.
- **401 / 403 / OTP:** update the GitHub `NPM_TOKEN` secret with suitable permissions, then rerun the failed job. Keep valid published versions and tags immutable.
- **Already published:** skip upload only when npm integrity matches the CI-built artifact. Different content requires a new package version. Missing optional npm `gitHead` is not a failure.
- **Verification or GitHub Release failed after publish:** rerun the same commit or tag; verify and complete the existing publication without uploading again.
- **Code or packaging failure:** fix on `main`; bump any package whose tarball changes, then dispatch the intended package(s).
- **Wrong dist-tag:** inspect versions before deliberately correcting it. Same-version recovery does not move npm dist-tags.

Validate workflow YAML and embedded shell/JavaScript before pushing workflow changes. Registry validation always uses CI artifact integrity; a locally packed tarball from another platform is not automatically byte-identical.
