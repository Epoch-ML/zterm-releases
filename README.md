# ZTerm releases

This public repository is the narrow distribution boundary for verified ZTerm
desktop builds. It contains release requests, immutable GitHub Release assets,
and the two GitHub Pages update feeds:

- `https://epoch-ml.github.io/zterm-releases/preview/latest.json`
- `https://epoch-ml.github.io/zterm-releases/stable/latest.json`

Source remains in `Epoch-ML/zerg`. A source tag writes one canonical request on
a dedicated `release-request/<tag>` branch. A human must review and merge that
pull request; the source deploy key cannot push public `main`. This repository
then fetches only the request's exact source commit and matching tag with a
read-only deploy key. The Apple Silicon builder runs tests, lint, dependency
audits, and the desktop smoke test before handing the app to a fresh signer.
That signer checks out and executes no product source. Stable builds additionally
require Developer ID signing, notarization, stapling, and Gatekeeper assessment.

The updater archive is SHA-256 checked and signed with independent channel keys:
[`updater-preview.pubkey`](updater-preview.pubkey) and
[`updater-stable.pubkey`](updater-stable.pubkey). A fresh Ubuntu
signer job downloads the unsigned payload, checks out no product source, and
uses exact locked Tauri and minisign verifier versions before it receives the
step-scoped key for exactly one channel. All release credentials are
environment-scoped: both channel environments contain the read-only
`ZERG_SOURCE_DEPLOY_KEY`; `preview` contains only the preview updater key,
`stable` contains only the stable updater key plus Apple credentials. The
`zterm-feed` environment contains only a release-data-scoped deploy key. This
repository has no repository-wide Actions secrets. GitHub Release assets are
downloaded again over HTTPS and byte-compared before `latest.json` is promoted,
so a feed can never point at an unverified asset from the same run.

## Release policy

- Preview request/tag: `zterm-preview-v<strict SemVer>`
- Stable request/tag: `zterm-v<MAJOR.MINOR.PATCH>`
- Initial platform: `darwin-aarch64`
- Bundle identifier: `dev.zerg.zterm`
- Publication is serialized and never cancels an in-progress release.
- Existing release tags are immutable and are never overwritten.
- Main requires a human-reviewed pull request.
- The workflow writes feeds only to `release-data`, never to `main`.
- A feed version can only advance; same-version retries require identical bytes.
- The exact Pages deployment is fetched over HTTPS and byte-compared last.

The `preview` and `stable` GitHub environments separate release policy and may
require reviewers. Stable fails closed unless every required Apple identity,
notarization secret, and stable-only updater key is present. A stable client
also requires the candidate's notarized Developer ID TeamIdentifier to match
the installed stable app, so a preview/ad-hoc artifact cannot cross channels.

## Local verification

```bash
npm ci --ignore-scripts
npm test
npm run test:mutation
actionlint .github/workflows/release.yml
npm audit --audit-level=moderate
```

Mutation testing is intentionally scoped to the untrusted request validator.
The build workflow itself is covered by explicit ordering, provenance, signing,
audit, shipped-binary smoke, and feed-promotion contract assertions.
