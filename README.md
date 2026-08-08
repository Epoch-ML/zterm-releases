# ZTerm releases

This public repository is the narrow distribution boundary for verified ZTerm
desktop builds. It contains release requests, immutable GitHub Release assets,
and the two GitHub Pages update feeds:

- `https://epoch-ml.github.io/zterm-releases/preview/latest.json`
- `https://epoch-ml.github.io/zterm-releases/stable/latest.json`

Source remains in `Epoch-ML/zerg`. A protected source tag emits one canonical
request as a deterministic workflow artifact; the source workflow has no
credential or write path into this repository. A human adds those unchanged
bytes in a one-file pull request, merges it into protected `main`, and creates
the matching protected public tag at the request's unique addition commit.
The manually dispatched public workflow verifies that complete chain before it
fetches only the request's exact source commit and matching source tag through a
read-only deploy key. The Apple Silicon builder runs tests, lint, dependency
audits, and the desktop smoke test before handing the app to a fresh signer.
That signer checks out and executes no product source. Stable builds additionally
require Developer ID signing, notarization, stapling, and Gatekeeper assessment.

The updater archive is SHA-256 checked and signed with independent channel keys:
[`updater-preview.pubkey`](updater-preview.pubkey) and
[`updater-stable.pubkey`](updater-stable.pubkey). A fresh Ubuntu
signer job downloads the unsigned payload, checks out no product source, and
uses exact locked Tauri and minisign verifier versions before it receives the
step-scoped key for exactly one channel. Release credentials are split across
fresh, environment-scoped runners:

- `zterm-source` contains only the read-only `ZERG_SOURCE_DEPLOY_KEY`;
- `zterm-apple-preview` contains no secrets and performs ad-hoc signing;
- `zterm-apple-stable` contains only Developer ID and notarization credentials;
- `zterm-updater-preview` and `zterm-updater-stable` contain distinct updater
  private keys for their respective public roots; and
- `zterm-feed` contains only the write deploy key scoped to `release-data`.

Stable Apple and updater environments require explicit human approval and do
not allow administrator bypass. Every release environment is restricted to
`main`, and this repository has no repository-wide Actions secrets. GitHub
Release assets are downloaded again over HTTPS and byte-compared before
`latest.json` is promoted, so a feed can never point at an unverified asset
from the same run.

## Release policy

- Preview request/tag: `zterm-preview-v<strict SemVer>`
- Stable request/tag: `zterm-v<MAJOR.MINOR.PATCH>`
- Initial platform: `darwin-aarch64`
- Bundle identifier: `dev.zerg.zterm`
- Publication is serialized and never cancels an in-progress release.
- Existing release tags are immutable and are never overwritten.
- Main accepts changes only through squash pull requests with linear history.
- The workflow writes feeds only to `release-data`, never to `main`.
- A feed version can only advance; same-version retries require identical bytes.
- The exact Pages deployment is fetched over HTTPS and byte-compared last.

The channel-specific Apple and updater environments separate release policy and
trust roots. Stable fails closed unless every required Apple identity,
notarization secret, and stable-only updater key is present. A stable client
also requires the candidate's notarized Developer ID TeamIdentifier to match
the installed stable app, so a preview/ad-hoc artifact cannot cross channels.

ZTC-launched ZTerm 0.1.2 sessions predate the session-preserving update
handshake. Install the first protocol-bearing release from its signed DMG once;
automatic signed updates with session restoration resume from that release.

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
