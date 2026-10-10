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

## ZTC signing bridge

`ztc-bridge.yml` is an additive, artifact-only path for the new self-contained
`ztc.app` distribution. It leaves the ZTerm release workflow, tags, releases and
feeds unchanged. It reuses the existing `zterm-source`, `zterm-apple-stable` and
channel-specific updater environments, so no private keys need to be copied or
exported. Both ZTC channels require Developer ID signing and notarization.

The bridge executes the ZTC publisher policy pinned to
`Epoch-ML/ztc-releases@bedcdd03c6358268253ad8bf8d465427ee90c69e`.
Request files are data from that repository's protected `main`: the bridge checks
that each request has one unchanged, one-file addition commit and that the
matching immutable public tag points to that commit. The exact source tag and
npm integrity are then checked by the pinned builder. Advancing the policy pin
requires another reviewed change here.

After npm publication and the matching source tag and reviewed request/tag in
`Epoch-ML/ztc-releases` exist, dispatch from this repository's protected `main`:

```sh
gh workflow run ztc-bridge.yml --repo Epoch-ML/zterm-releases --ref main \
  -f channel=preview -f version=0.5.0-beta.1 \
  -f source_sha=639a0d0cc4d6e3eed77db19d937862ab82a36f22
```

The run ends after validating the signed app and signing its updater archive and
catalog. Its artifact is named `ztc-desktop-preview-v<version>` (or
`ztc-desktop-v<version>` for stable), with the eight canonical release files.
URLs in those files name `Epoch-ML/ztc-releases`, never this signing repository.
The bridge has read-only repository permissions and no release/feed write step.

An authorized operator can download the artifact with `gh run download`, verify
its run provenance and every payload hash/signature using the pinned publisher,
and hand it to the new repository's publication process. Publication still needs
the immutable request/tag checks, a fresh download and verification of all eight
GitHub Release assets, matching Homebrew formula and installer, clean-machine
qualification, monotonic feed promotion, and verification of the deployed feed.
A successful bridge run alone does not activate a public download.
