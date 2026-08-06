import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  readReleaseRequest,
  ReleaseRequestError,
  validateReleaseRequest,
} from "./release-request.mjs";

const SOURCE_SHA = "0123456789abcdef0123456789abcdef01234567";

function request(overrides = {}) {
  return {
    schema_version: 1,
    product: "ZTerm",
    channel: "preview",
    version: "0.2.0-preview.1",
    release_tag: "zterm-preview-v0.2.0-preview.1",
    source_repository: "Epoch-ML/zerg",
    source_sha: SOURCE_SHA,
    source_ref: "refs/tags/zterm-preview-v0.2.0-preview.1",
    requested_at: "2026-08-05T20:00:00.000Z",
    ...overrides,
  };
}

test("accepts and canonicalizes the exact ZTerm preview request", () => {
  assert.deepEqual(validateReleaseRequest(request()), request());
});

test("rejects another product or source repository", () => {
  assert.throws(
    () => validateReleaseRequest(request({ product: "ZergLang IDE" })),
    /product must equal ZTerm/,
  );
  assert.throws(
    () => validateReleaseRequest(request({ source_repository: "someone/fork" })),
    /source_repository must equal Epoch-ML\/zerg/,
  );
});

test("stable permits only numeric MAJOR.MINOR.PATCH", () => {
  for (const version of ["1.0.0-rc.1", "1.0.0+build.7"]) {
    assert.throws(
      () =>
        validateReleaseRequest(
          request({
            channel: "stable",
            version,
            release_tag: `zterm-v${version}`,
            source_ref: `refs/tags/zterm-v${version}`,
          }),
        ),
      /stable versions must use MAJOR\.MINOR\.PATCH/,
    );
  }
  const stable = validateReleaseRequest(
    request({
      channel: "stable",
      version: "12.34.567",
      release_tag: "zterm-v12.34.567",
      source_ref: "refs/tags/zterm-v12.34.567",
    }),
  );
  assert.equal(stable.release_tag, "zterm-v12.34.567");
  assert.equal(stable.source_ref, "refs/tags/zterm-v12.34.567");
});

test("rejects malformed provenance and extra policy fields", () => {
  assert.throws(
    () => validateReleaseRequest(request({ source_sha: "main" })),
    /40 lowercase hexadecimal/,
  );
  assert.throws(
    () => validateReleaseRequest(request({ source_ref: "refs/heads/main" })),
    /source_ref must equal/,
  );
  assert.throws(
    () => validateReleaseRequest(request({ skip_notarization: true })),
    /unexpected field/,
  );
});

test("rejects non-object, incomplete, and invalid discriminator requests", () => {
  for (const value of [null, [], "request"]) {
    assert.throws(
      () => validateReleaseRequest(value),
      (error) =>
        error instanceof ReleaseRequestError &&
        error.name === "ReleaseRequestError" &&
        /JSON object/.test(error.message),
    );
  }
  for (const field of Object.keys(request())) {
    const incomplete = request();
    delete incomplete[field];
    assert.throws(
      () => validateReleaseRequest(incomplete),
      new RegExp(`missing required field: ${field}`),
    );
  }
  assert.throws(
    () => validateReleaseRequest(request({ schema_version: 2 })),
    /schema_version must equal 1/,
  );
  assert.throws(
    () => validateReleaseRequest(request({ channel: "nightly" })),
    /channel must be preview or stable/,
  );
});

test("accepts strict preview SemVer and rejects malformed or noncanonical versions", () => {
  for (const version of [
    "10.20.300",
    "1.2.3-10",
    "1.2.3-123",
    "1.2.3-alpha",
    "1.2.3-alpha.beta",
    "1.2.3-alpha.abc-def",
    "1.2.3-rc.10+build.2",
    "1.2.3+build",
    "1.2.3+one.two.three",
    "1.2.3-alpha-beta+long-value.123",
  ]) {
    const value = request({
      version,
      release_tag: `zterm-preview-v${version}`,
      source_ref: `refs/tags/zterm-preview-v${version}`,
    });
    assert.equal(validateReleaseRequest(value).version, version);
  }
  for (const version of [
    null,
    "",
    " 1.2.3",
    "1.2.3 ",
    "x1.2.3",
    "1.2.3x",
    "01.2.3",
    "1.02.3",
    "1.2.03",
    "1.2",
    "1.2.3.4",
    "1.a.3",
    "1.2.a",
    "-1.2.3",
    "1.2.3-",
    "1.2.3+",
    "1.2.3-01",
    "1.2.3-a..b",
    "1.2.3+meta..x",
  ]) {
    assert.throws(
      () => validateReleaseRequest(request({ version })),
      /version must (?:be a non-empty string|be strict SemVer|not contain surrounding whitespace)/,
    );
  }
  assert.throws(
    () => validateReleaseRequest(request({ version: "" })),
    /version must be a non-empty string/,
  );
});

test("validates exact SHA, tag, and canonical UTC timestamp boundaries", () => {
  for (const source_sha of [
    null,
    "",
    ` ${SOURCE_SHA}`,
    SOURCE_SHA.toUpperCase(),
    SOURCE_SHA.slice(1),
    `${SOURCE_SHA}0`,
    `g${SOURCE_SHA.slice(1)}`,
  ]) {
    assert.throws(
      () => validateReleaseRequest(request({ source_sha })),
      /source_sha must (?:be a non-empty string|not contain surrounding whitespace|contain exactly 40 lowercase hexadecimal characters)/,
    );
  }
  assert.throws(
    () => validateReleaseRequest(request({ source_sha: "" })),
    /source_sha must be a non-empty string/,
  );
  assert.throws(
    () => validateReleaseRequest(request({ release_tag: "zterm-preview-v9.9.9" })),
    /release_tag must equal zterm-preview-v0.2.0-preview.1/,
  );
  for (const requested_at of [
    null,
    "",
    " 2026-08-05T20:00:00.000Z",
    "x2026-08-05T20:00:00.000Z",
    "2026-08-05T20:00:00.000Zx",
    "2026-08-05T20:00:00Z",
    "2026-08-05T20:00:00.000+00:00",
    "2026-02-30T20:00:00.000Z",
    "2026-08-05T20:00:00.000Z\ninjected_output=true",
  ]) {
    assert.throws(
      () => validateReleaseRequest(request({ requested_at })),
      /requested_at must (?:be a non-empty string|not contain surrounding whitespace|be an ISO-8601 UTC timestamp)/,
    );
  }
  assert.throws(
    () => validateReleaseRequest(request({ requested_at: "" })),
    /requested_at must be a non-empty string/,
  );
});

test("canonical timestamp validation precedes every workflow output", async () => {
  const validator = await readFile(
    new URL("./release-request.mjs", import.meta.url),
    "utf8",
  );
  const workflow = await readFile(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  assert.match(validator, /new Date\(requestedAt\)\.toISOString\(\) !== requestedAt/);
  const validationIndex = workflow.indexOf(
    'node scripts/release-request.mjs "$candidate" >"$request_path"',
  );
  const outputIndex = workflow.indexOf('>>"$GITHUB_OUTPUT"', validationIndex);
  assert.ok(validationIndex >= 0);
  assert.ok(outputIndex > validationIndex);
});

test("validation installs and audits locked policy dependencies before testing", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  const validationJob = workflow.slice(
    workflow.indexOf("  validate:"),
    workflow.indexOf("  build:"),
  );
  const checkoutIndex = validationJob.indexOf("actions/checkout@");
  const setupIndex = validationJob.indexOf(
    "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7",
  );
  const installIndex = validationJob.indexOf(
    "npm ci --ignore-scripts --no-audit --no-fund",
  );
  const auditIndex = validationJob.indexOf("npm audit --audit-level=moderate");
  const testIndex = validationJob.indexOf("npm test");
  assert.ok(checkoutIndex >= 0, "policy checkout must happen first");
  assert.ok(setupIndex > checkoutIndex, "the exact Node toolchain must be installed");
  assert.ok(installIndex > setupIndex, "locked dependencies must precede policy execution");
  assert.ok(auditIndex > installIndex, "the installed production tree must be audited");
  assert.ok(testIndex > auditIndex, "policy tests may run only after installation and audit");
  assert.match(validationJob, /node-version: "22\.23\.2"/);
  assert.match(validationJob, /cache-dependency-path: package-lock\.json/);
});

test("workflow is dispatch-only from protected main and requires a pre-existing exact public tag", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  const trigger = workflow.slice(workflow.indexOf("on:"), workflow.indexOf("permissions:"));
  assert.match(trigger, /workflow_dispatch:/);
  assert.doesNotMatch(trigger, /\bpush:/);
  assert.match(workflow, /GITHUB_REF.*refs\/heads\/main/s);
  const validationJob = workflow.slice(
    workflow.indexOf("  validate:"),
    workflow.indexOf("  build:"),
  );
  assert.match(validationJob, /git ls-remote --tags origin/);
  assert.match(validationJob, /refs\/tags\/\$release_tag\^\{\}/);
  const lookupIndex = validationJob.indexOf("git ls-remote --tags origin");
  const emptyTagIndex = validationJob.indexOf('if [[ -z "$tag_target" ]]', lookupIndex);
  const missingTagErrorIndex = validationJob.indexOf(
    "public release tag $release_tag does not exist",
    emptyTagIndex,
  );
  const releaseOutputIndex = validationJob.indexOf(
    'echo "release_target_sha=$request_commit"',
    lookupIndex,
  );
  assert.ok(emptyTagIndex > lookupIndex, "an empty remote tag lookup must fail explicitly");
  assert.ok(missingTagErrorIndex > emptyTagIndex, "the failure must identify the missing tag");
  assert.ok(
    releaseOutputIndex > missingTagErrorIndex,
    "a missing tag must fail before any release output",
  );
  assert.match(validationJob, /tag_target.*request_commit/s);
  assert.doesNotMatch(workflow, /repos\/\$GITHUB_REPOSITORY\/git\/refs|--field "ref=refs\/tags/);
  assert.match(workflow, /gh release create "\$RELEASE_TAG" --verify-tag/);
});

test("rejects a release request path that is a symbolic link", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zterm-release-request-"));
  try {
    const target = join(directory, "target.json");
    const link = join(directory, "request.json");
    await writeFile(target, `${JSON.stringify(request())}\n`);
    await symlink(target, link);

    await assert.rejects(
      readReleaseRequest(link),
      (error) =>
        error instanceof ReleaseRequestError &&
        /regular file.*symbolic link/.test(error.message),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reads only bounded regular JSON request files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zterm-release-request-files-"));
  try {
    const canonical = JSON.stringify(request());
    const regular = join(directory, "regular.json");
    await writeFile(regular, canonical);
    assert.deepEqual(await readReleaseRequest(regular), request());

    await assert.rejects(
      readReleaseRequest(directory),
      (error) =>
        error instanceof ReleaseRequestError &&
        /regular file/.test(error.message),
    );

    const exactLimit = join(directory, "exact-limit.json");
    await writeFile(exactLimit, canonical.padEnd(16 * 1024, " "));
    assert.deepEqual(await readReleaseRequest(exactLimit), request());

    const overLimit = join(directory, "over-limit.json");
    await writeFile(overLimit, canonical.padEnd(16 * 1024 + 1, " "));
    await assert.rejects(
      readReleaseRequest(overLimit),
      (error) =>
        error instanceof ReleaseRequestError && /exceeds 16384 bytes/.test(error.message),
    );

    const malformed = join(directory, "malformed.json");
    await writeFile(malformed, "{not-json}");
    await assert.rejects(
      readReleaseRequest(malformed),
      (error) =>
        error instanceof ReleaseRequestError && /not valid JSON/.test(error.message),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("workflow performs an authenticated, LFS-bounded exact source checkout", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  const checkoutStart = workflow.indexOf("- name: Check out the exact source commit and tag");
  const checkoutEnd = workflow.indexOf("- name: Verify source commit", checkoutStart);
  const checkoutStep = workflow.slice(checkoutStart, checkoutEnd);
  const metaIndex = workflow.indexOf("https://api.github.com/meta");
  const initIndex = workflow.indexOf("git init --ref-format=reftable source");
  const commitFetchIndex = workflow.indexOf(
    'git -C source fetch --no-tags --depth=1 origin "$EXPECTED_SHA"',
  );
  const tagFetchIndex = workflow.indexOf(
    'git -C source fetch --no-tags --depth=1 origin "$EXPECTED_REF:$EXPECTED_REF"',
  );
  assert.ok(metaIndex >= 0, "SSH host key must come from GitHub metadata");
  assert.ok(initIndex > metaIndex, "source checkout must use an isolated reftable repository");
  assert.ok(commitFetchIndex > initIndex, "only the requested source SHA may be fetched");
  assert.ok(tagFetchIndex > commitFetchIndex, "only the matching tag may be fetched");
  assert.match(checkoutStep, /SOURCE_DEPLOY_KEY: \$\{\{ secrets\.ZERG_SOURCE_DEPLOY_KEY \}\}/);
  assert.match(checkoutStep, /GITHUB_META_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(
    checkoutStep,
    /--header "Authorization: Bearer \$GITHUB_META_TOKEN"/,
  );
  assert.match(
    checkoutStep,
    /GIT_LFS_SKIP_SMUDGE=1 git -C source checkout --detach "\$EXPECTED_SHA"/,
  );
});

test("workflow refuses a tracked symbolic-link release request", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  assert.equal(workflow.match(/-L "\$candidate"/g)?.length, 2);
});

test("workflow binds a merged request to one immutable normal-file addition commit", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /git log --format=%H --diff-filter=A/);
  assert.match(workflow, /addition_commits/);
  assert.match(workflow, /commit_and_parents/);
  assert.match(workflow, /addition_changes/);
  assert.match(workflow, /request_mode/);
  assert.match(workflow, /100644/);
  assert.match(workflow, /cmp --silent/);
  assert.match(workflow, /release_target_sha=\$request_commit/);
});

test("workflow keeps signing, stable Apple identity, and Pages promotion fail-closed", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  for (const name of [
    "ZTERM_PREVIEW_UPDATE_SIGNING_PRIVATE_KEY",
    "ZTERM_PREVIEW_UPDATE_SIGNING_PRIVATE_KEY_PASSWORD",
    "ZTERM_STABLE_UPDATE_SIGNING_PRIVATE_KEY",
    "ZTERM_STABLE_UPDATE_SIGNING_PRIVATE_KEY_PASSWORD",
  ]) {
    assert.match(workflow, new RegExp(name));
  }
  for (const name of [
    "ZTERM_APPLE_CERTIFICATE",
    "ZTERM_APPLE_CERTIFICATE_PASSWORD",
    "ZTERM_APPLE_SIGNING_IDENTITY",
    "ZTERM_APPLE_API_ISSUER",
    "ZTERM_APPLE_API_KEY_ID",
    "ZTERM_APPLE_API_PRIVATE_KEY",
  ]) {
    assert.match(workflow, new RegExp(name));
  }
  const compareIndex = workflow.indexOf(
    "Validate release metadata and compare every published asset over HTTPS",
  );
  const manifestIndex = workflow.indexOf("Commit updater manifest after asset verification");
  assert.ok(compareIndex >= 0, "published assets must be fetched over HTTPS");
  assert.ok(manifestIndex > compareIndex, "Pages manifest must be promoted last");
});

test("workflow builds only the native Apple Silicon ZTerm app contract", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /runs-on: macos-15/);
  assert.match(workflow, /ZTERM_RELEASE_VERSION/);
  assert.match(workflow, /ZTERM_UPDATE_CHANNEL/);
  assert.match(workflow, /package-zterm-macos\.mjs/);
  assert.match(workflow, /ZTerm\.app\.tar\.gz/);
  assert.match(workflow, /ZTerm_.*_aarch64\.dmg/);
  assert.match(workflow, /tests\/unit\/zterm_release_rerun\.test\.ts/);
  assert.doesNotMatch(workflow, /tauri build|src-tauri/);
});

test("workflow isolates updater signing from every source-authored process", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  const buildJob = workflow.slice(
    workflow.indexOf("  build:"),
    workflow.indexOf("  apple-sign:"),
  );
  const signJob = workflow.slice(workflow.indexOf("  sign:"), workflow.indexOf("  publish:"));
  assert.doesNotMatch(buildJob, /ZTERM_(?:PREVIEW|STABLE)_UPDATE_SIGNING_PRIVATE_KEY/);
  assert.match(signJob, /needs:\s+- validate\s+- apple-sign\s+- verify-signed/);
  assert.match(
    signJob,
    /environment:\s+name: zterm-updater-\$\{\{ needs\.validate\.outputs\.channel \}\}/,
  );
  assert.match(signJob, /ZTERM_PREVIEW_UPDATE_SIGNING_PRIVATE_KEY/);
  assert.match(signJob, /ZTERM_STABLE_UPDATE_SIGNING_PRIVATE_KEY/);
  assert.match(signJob, /release-index\/updater-\$RELEASE_CHANNEL\.pubkey/);
  assert.match(signJob, /download-artifact/);
  assert.doesNotMatch(
    signJob,
    /Epoch-ML\/zerg(?:\.git)?|path: source|source\/ztc|SOURCE_DEPLOY_KEY|tests\//,
  );
  assert.match(workflow, /name: .*unsigned ZTerm application/i);
  assert.match(workflow, /name: .*Apple-signed ZTerm release payload/i);
  assert.match(workflow, /name: .*signed ZTerm release payload/i);
  assert.match(workflow, /publish:\s+[\s\S]*needs:\s+- validate\s+- sign/);
});

test("workflow isolates Apple signing and notarization on a fresh non-executing runner", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  const buildJob = workflow.slice(
    workflow.indexOf("  build:"),
    workflow.indexOf("  apple-sign:"),
  );
  const appleJob = workflow.slice(
    workflow.indexOf("  apple-sign:"),
    workflow.indexOf("  verify-signed:"),
  );
  assert.match(appleJob, /runs-on: macos-15/);
  assert.match(
    appleJob,
    /environment:\s+name: zterm-apple-\$\{\{ needs\.validate\.outputs\.channel \}\}/,
  );
  assert.match(appleJob, /actions\/download-artifact@/);
  assert.match(appleJob, /ZTERM_APPLE_CERTIFICATE/);
  assert.match(appleJob, /codesign/);
  assert.match(appleJob, /notarytool/);
  assert.doesNotMatch(buildJob, /ZTERM_APPLE_CERTIFICATE|notarytool|codesign/);
  assert.doesNotMatch(
    appleJob,
    /Epoch-ML\/zerg(?:\.git)?|path: source|source\/ztc|SOURCE_DEPLOY_KEY|cargo (?:test|build)|npm (?:test|run)|\$\(\$executable --version\)|ZTERM_SMOKE_BINARY/,
  );
  assert.match(workflow, /sign:\s+[\s\S]*needs:\s+- validate\s+- apple-sign/);
});

test("workflow reconstructs and fail-closed validates the flattened unsigned app artifact", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  const appleJob = workflow.slice(
    workflow.indexOf("  apple-sign:"),
    workflow.indexOf("  verify-signed:"),
  );
  const downloadStep = appleJob.slice(
    appleJob.indexOf("actions/download-artifact@"),
    appleJob.indexOf("Validate the non-executable product payload"),
  );
  const validationStep = appleJob.slice(
    appleJob.indexOf("Validate the non-executable product payload"),
    appleJob.indexOf("Require and import stable Apple identity"),
  );

  assert.match(
    downloadStep,
    /path: unsigned\/ZTerm\.app/,
    "upload-artifact flattens the app directory, so download must recreate ZTerm.app",
  );
  assert.doesNotMatch(
    validationStep,
    /^\s*\[\[/m,
    "standalone [[ assertions do not fail a Bash errexit script",
  );
  assert.match(validationStep, /test -d "\$app"/);
  assert.match(validationStep, /test -z "\$\(find .* -type l -print -quit\)"/);
  assert.match(
    validationStep,
    /test "\$\(find .* -type f \| wc -l \| tr -d ' '\)" = "3"/,
  );
  assert.match(validationStep, /test -f "\$app\/Contents\/Info\.plist"/);
  assert.match(validationStep, /test -f "\$app\/Contents\/PkgInfo"/);
  assert.match(validationStep, /test -f "\$executable"/);
  assert.match(validationStep, /test -z "\$unexpected"/);
  assert.match(validationStep, /file -b "\$executable" \| grep -F arm64/);
  assert.match(validationStep, /Print :CFBundleIdentifier/);
  assert.match(validationStep, /grep -Fx dev\.zerg\.zterm/);
  assert.match(validationStep, /Print :CFBundleExecutable/);
  assert.match(validationStep, /grep -Fx ZTerm/);
  assert.doesNotMatch(validationStep, /\$executable --version|ZTERM_SMOKE_BINARY/);
});

test("workflow separates source, Apple, updater, and feed credential environments", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  const buildJob = workflow.slice(workflow.indexOf("  build:"), workflow.indexOf("  apple-sign:"));
  const appleJob = workflow.slice(
    workflow.indexOf("  apple-sign:"),
    workflow.indexOf("  verify-signed:"),
  );
  const updaterJob = workflow.slice(workflow.indexOf("  sign:"), workflow.indexOf("  publish:"));
  assert.match(buildJob, /environment: zterm-source/);
  assert.doesNotMatch(buildJob, /zterm-apple-|zterm-updater-/);
  assert.match(appleJob, /name: zterm-apple-\$\{\{ needs\.validate\.outputs\.channel \}\}/);
  assert.doesNotMatch(appleJob, /zterm-source|zterm-updater-/);
  assert.match(updaterJob, /name: zterm-updater-\$\{\{ needs\.validate\.outputs\.channel \}\}/);
  assert.doesNotMatch(updaterJob, /zterm-source|zterm-apple-/);
  assert.match(workflow, /environment: zterm-feed/);
  assert.doesNotMatch(workflow, /environment: \$\{\{ needs\.validate\.outputs\.channel \}\}/);
});

test("workflow uses a monotonic release-data feed and verifies Pages after deployment", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /ref: release-data/);
  assert.match(workflow, /environment: zterm-feed/);
  assert.equal(
    workflow.match(/secrets\.ZTERM_FEED_DEPLOY_KEY/g)?.length,
    1,
    "the release-data deploy key belongs only to its checkout",
  );
  assert.match(workflow, /node .*scripts\/feed-policy\.mjs/);
  assert.doesNotMatch(workflow, /git push origin HEAD:main/);
  const deployJob = workflow.indexOf("  deploy-pages:");
  const deployAction = workflow.indexOf("actions/deploy-pages@", deployJob);
  const verifyJob = workflow.indexOf("  verify-pages:");
  const liveFetch = workflow.indexOf("Verify the published channel manifest over HTTPS");
  assert.ok(deployJob > 0);
  assert.ok(deployAction > deployJob);
  assert.ok(verifyJob > deployAction);
  assert.ok(liveFetch > verifyJob);
});

test("workflow uploads one deterministic Pages archive through the pinned direct action", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  const promotionStart = workflow.indexOf("  promote-feed:");
  const deployStart = workflow.indexOf("  deploy-pages:");
  const promotion = workflow.slice(promotionStart, deployStart);

  assert.doesNotMatch(
    promotion,
    /actions\/upload-pages-artifact@/,
    "the composite invokes an unpinned upload-artifact@v4 rejected by organization policy",
  );
  assert.match(promotion, /Create deterministic Pages artifact/);
  for (const option of [
    "--dereference",
    "--hard-dereference",
    "--sort=name",
    "--mtime='UTC 1970-01-01'",
    "--owner=0",
    "--group=0",
    "--numeric-owner",
  ]) {
    assert.ok(promotion.includes(option), `Pages archive must use ${option}`);
  }
  assert.match(promotion, /--directory data\/site/);
  assert.match(promotion, /"\$RUNNER_TEMP\/artifact\.tar"/);
  assert.match(
    promotion,
    /uses: actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4/,
  );
  const directUpload = promotion.slice(
    promotion.indexOf("actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02"),
  );
  assert.match(directUpload, /name: github-pages/);
  assert.match(directUpload, /path: \$\{\{ runner\.temp \}\}\/artifact\.tar/);
  assert.match(directUpload, /retention-days: 1/);
  assert.match(directUpload, /if-no-files-found: error/);
});

test("workflow rejects symlinks and special entries before Pages tar dereference", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  const promotion = workflow.slice(
    workflow.indexOf("  promote-feed:"),
    workflow.indexOf("  deploy-pages:"),
  );
  const unsafeEntryGate = promotion.indexOf('unsafe_path="$(');
  const tarCreation = promotion.indexOf("          tar \\");

  assert.ok(
    unsafeEntryGate >= 0 && unsafeEntryGate < tarCreation,
    "symlinks and special entries must fail before tar dereferences the Pages tree",
  );
  assert.match(
    promotion,
    /find data\/site[\s\\\n]+! -type f[\s\\\n]+! -type d[\s\\\n]+-print -quit/,
  );
  assert.match(promotion, /Pages site contains a symlink or special file/);
  assert.match(promotion.slice(unsafeEntryGate, tarCreation), /exit 1/);
});

test("workflow passes dispatch inputs to shell only through env", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /INPUT_CHANNEL: \$\{\{ inputs\.channel \}\}/);
  assert.match(workflow, /INPUT_SOURCE_SHA: \$\{\{ inputs\.source_sha \}\}/);
  assert.match(workflow, /INPUT_VERSION: \$\{\{ inputs\.version \}\}/);
  assert.doesNotMatch(workflow, /(?:channel|source_sha|version)="\$\{\{ inputs\./);
});

test("workflow pins runner, Node, and verifier tools without duplicate release steps", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(workflow, /node-version: "22"(?:\s|$)/);
  assert.match(workflow, /node-version: "22\.23\.2"/);
  assert.doesNotMatch(workflow, /brew install minisign/);
  assert.doesNotMatch(workflow, /cargo install minisign/);
  assert.match(
    workflow,
    /https:\/\/github\.com\/jedisct1\/minisign\/releases\/download\/0\.12\/minisign-0\.12-linux\.tar\.gz/,
  );
  assert.match(
    workflow,
    /9a599b48ba6eb7b1e80f12f36b94ceca7c00b7a5173c95c3efc88d9822957e73/,
  );
  assert.equal(
    workflow.match(/git -C source checkout --detach "\$EXPECTED_SHA"/g)?.length,
    1,
  );
  assert.equal(
    workflow.match(/actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/g)
      ?.length,
    4,
  );
});

test("workflow smoke-tests before isolation and rechecks the exact signed application without secrets", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  const buildSmokeIndex = workflow.indexOf(
    "Smoke test the unsigned build before credential isolation",
  );
  const unsignedUploadIndex = workflow.indexOf("Upload unsigned ZTerm application");
  const signingIndex = workflow.indexOf("Sign ZTerm without launching its executable");
  const staplingIndex = workflow.indexOf("Notarize and staple stable application");
  const archiveIndex = workflow.indexOf("Create signed updater archive and disk image");
  const shippedSmokeIndex = workflow.indexOf(
    "Verify and launch the exact signed application",
  );
  assert.ok(buildSmokeIndex < unsignedUploadIndex, "source tests must precede isolation");
  assert.ok(signingIndex > unsignedUploadIndex, "Apple signing must use the transferred app");
  assert.ok(archiveIndex > staplingIndex, "stable stapling must precede the updater archive");
  assert.ok(
    shippedSmokeIndex > archiveIndex,
    "a credential-free runner must exercise the exact signed archive",
  );
});

test("workflow documents the target-scoped Rust advisory exception and audits Node tooling", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /cargo tree --target all -i quick-xml/);
  assert.match(
    workflow,
    /cargo audit --file packages\/zterm\/Cargo\.lock[\s\\\n]+--ignore RUSTSEC-2026-0194[\s\\\n]+--ignore RUSTSEC-2026-0195/,
  );
  assert.match(workflow, /npm audit --audit-level=moderate --prefix release-index/);
  assert.match(workflow, /npm audit --omit=dev --audit-level=moderate/);
});

test("workflow updates release-data and enforces feed policy before copying manifests", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  const promotionIndex = workflow.indexOf("Commit updater manifest after asset verification");
  const pullIndex = workflow.indexOf(
    "git -C data pull --ff-only origin release-data",
    promotionIndex,
  );
  const policyIndex = workflow.indexOf("node policy/scripts/feed-policy.mjs", promotionIndex);
  const copyIndex = workflow.indexOf('cp payload/latest.json "$latest_path"', promotionIndex);
  assert.ok(pullIndex > promotionIndex, "the current release-data branch must be fetched");
  assert.ok(policyIndex > pullIndex, "monotonic policy must inspect current release-data");
  assert.ok(copyIndex > policyIndex, "only a policy-approved manifest may be copied");
  assert.doesNotMatch(workflow.slice(promotionIndex), /git pull --rebase/);
});

test("workflow pins every GitHub-authored action to an immutable commit", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  const pins = [
    ["checkout", "3d3c42e5aac5ba805825da76410c181273ba90b1", "v7"],
    ["setup-node", "820762786026740c76f36085b0efc47a31fe5020", "v7"],
    ["cache", "0057852bfaa89a56745cba8c7296529d2fc39830", "v4"],
    ["upload-artifact", "ea165f8d65b6e75b540449e92b4886f43607fa02", "v4"],
    ["download-artifact", "d3f86a106a0bac45b974a628896c90dbdf5c8093", "v4"],
    ["configure-pages", "983d7736d9b0ae728b81ab479565c72886d7745b", "v5"],
    ["deploy-pages", "cd2ce8fcbc39b97be8ca5fce6e763baed58fa128", "v5"],
  ];
  for (const [action, sha, version] of pins) {
    assert.match(workflow, new RegExp(`actions/${action}@${sha} # ${version}`));
  }
  assert.doesNotMatch(workflow, /uses: actions\/[^@\s]+@v\d+/);
});

test("workflow resumes only an exactly matching immutable GitHub Release", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /Create or resume immutable GitHub Release/);
  assert.doesNotMatch(workflow, /release already exists and will not be overwritten/);
  assert.doesNotMatch(workflow, /gh release (?:delete|upload[^\n]*--clobber)/);
  const resumeIndex = workflow.indexOf("Create or resume immutable GitHub Release");
  const verificationIndex = workflow.indexOf(
    "Validate release metadata and compare every published asset over HTTPS",
  );
  assert.ok(verificationIndex > resumeIndex, "existing releases must pass the common gate");
  const draftCreateIndex = workflow.indexOf("--draft", resumeIndex);
  const publishIndex = workflow.indexOf("gh release edit", verificationIndex);
  assert.ok(draftCreateIndex > resumeIndex, "new releases must begin as drafts");
  assert.ok(publishIndex > verificationIndex, "only verified drafts may be published");
  assert.match(workflow.slice(publishIndex), /--draft=false/);
  assert.match(workflow, /gh release upload "\$RELEASE_TAG" "\$local_path"/);
  const verification = workflow.slice(verificationIndex);
  assert.match(verification, /\.tag_name == \$tag/);
  assert.doesNotMatch(verification, /\.target_commitish == \$target/);
  assert.match(verification, /\.name == \$title/);
  assert.match(verification, /\.prerelease == \$prerelease/);
  assert.match(verification, /cmp "\$local_path" "\$verify_dir\/\$asset_name"/);
  assert.match(workflow, /release_target_sha: \$\{\{ steps\.request\.outputs\.release_target_sha \}\}/);
  assert.match(workflow, /RELEASE_TARGET_SHA: \$\{\{ needs\.validate\.outputs\.release_target_sha \}\}/);
  assert.doesNotMatch(workflow, /--target "\$RELEASE_TARGET_SHA"/);
  assert.match(workflow, /gh release create "\$RELEASE_TAG" --verify-tag/);
  assert.match(workflow, /candidate="requests\/\$\{release_tag\}\.json"/);
  assert.match(workflow, /git show "\$\{request_commit\}:\$candidate" >"\$addition_bytes"/);
  assert.match(workflow, /cmp --silent "\$candidate" "\$addition_bytes"/);
  assert.doesNotMatch(workflow, /manual-request\.json/);
});

test("workflow lets the verified existing tag select the release target", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  const draftStep = workflow.indexOf("Create or resume immutable GitHub Release draft");
  const verificationStep = workflow.indexOf(
    "Validate release metadata and compare every published asset over HTTPS",
  );
  const publishStep = workflow.indexOf("Publish fully verified GitHub Release");
  const feedJob = workflow.indexOf("  promote-feed:");
  const draftGate = workflow.slice(draftStep, verificationStep);
  const releaseMetadataGates = workflow.slice(verificationStep, feedJob);

  assert.doesNotMatch(
    draftGate,
    /--target "\$RELEASE_TARGET_SHA"/,
    "a supplied target commit can require workflow-write permission unavailable to GITHUB_TOKEN",
  );
  assert.match(
    draftGate,
    /gh release create "\$RELEASE_TAG" --verify-tag --draft/,
  );
  const tagResolution = draftGate.indexOf('tag_target="$(resolve_remote_release_tag)"');
  const createCommand = draftGate.indexOf('gh release create "$RELEASE_TAG"');
  assert.ok(tagResolution >= 0 && tagResolution < createCommand);
  assert.match(draftGate, /tag_target.*RELEASE_TARGET_SHA/s);
  assert.doesNotMatch(releaseMetadataGates, /\.target_commitish == \$target/);
  assert.match(workflow.slice(publishStep, feedJob), /tag_target.*RELEASE_TARGET_SHA/s);
});

test("workflow resolves draft and published releases through one bounded exact ID lookup", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  const verificationStep = workflow.indexOf(
    "Validate release metadata and compare every published asset over HTTPS",
  );
  const feedJob = workflow.indexOf("  promote-feed:");
  const releaseGates = workflow.slice(verificationStep, feedJob);

  assert.doesNotMatch(
    releaseGates,
    /releases\/tags\/\$RELEASE_TAG/,
    "GitHub's release-by-tag endpoint returns 404 for draft releases",
  );
  assert.match(releaseGates, /max_release_pages=100/);
  assert.match(
    releaseGates,
    /releases\?per_page=100&page=\$page/,
  );
  assert.match(releaseGates, /release lookup exceeded bounded pagination/);
  assert.match(releaseGates, /match_count.*-ne 1/s);
  assert.match(
    releaseGates,
    /gh api "repos\/\$GITHUB_REPOSITORY\/releases\/\$release_id"/,
  );
  assert.match(releaseGates, /\.id == \$id and \.tag_name == \$tag/);
  assert.equal(
    releaseGates.match(/fetch_exact_release "\$release_json"/g)?.length,
    4,
    "draft creation, asset upload, publication, and immutability must each re-read the exact release",
  );
});

test("workflow preserves latest.json as a byte-verified immutable release asset", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  const assetGate = workflow.slice(
    workflow.indexOf("Validate release metadata and compare every published asset over HTTPS"),
    workflow.indexOf("Publish fully verified GitHub Release"),
  );
  const immutableGate = workflow.slice(
    workflow.indexOf("Publish fully verified GitHub Release"),
    workflow.indexOf("  promote-feed:"),
  );
  for (const gate of [assetGate, immutableGate]) {
    assert.match(gate, /find payload -maxdepth 1 -type f -print \| sort/);
    assert.doesNotMatch(gate, /! -name latest\.json/);
    assert.match(gate, /for local_path in "\$\{local_assets\[@\]\}"/);
    assert.match(gate, /cmp "\$local_path"/);
  }
  assert.match(assetGate, /gh release upload "\$RELEASE_TAG" "\$local_path"/);
  assert.match(immutableGate, /\.browser_download_url/);
});

test("workflow pins the live release tag before draft creation and after publication", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  const draftStep = workflow.indexOf("Create or resume immutable GitHub Release draft");
  const createCommand = workflow.indexOf('gh release create "$RELEASE_TAG"', draftStep);
  const firstTagResolution = workflow.indexOf(
    'tag_target="$(resolve_remote_release_tag)"',
    draftStep,
  );
  const publishStep = workflow.indexOf("Publish fully verified GitHub Release");
  const publishCommand = workflow.indexOf('gh release edit "$RELEASE_TAG"', publishStep);
  const finalTagResolution = workflow.indexOf(
    'tag_target="$(resolve_remote_release_tag)"',
    publishCommand,
  );
  assert.ok(firstTagResolution > draftStep && firstTagResolution < createCommand);
  assert.ok(finalTagResolution > publishCommand);
  assert.match(workflow, /git -C index ls-remote --tags origin/);
  assert.match(workflow, /refs\/tags\/\$RELEASE_TAG\^\{\}/);
  assert.match(workflow, /tag_target.*RELEASE_TARGET_SHA/s);
  assert.doesNotMatch(workflow, /repos\/\$GITHUB_REPOSITORY\/git\/refs|gh api --method POST.*git\/refs/s);
});

test("workflow requires GitHub release immutability before feed promotion", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  const publicationIndex = workflow.indexOf('gh release edit "$RELEASE_TAG" --draft=false');
  const immutableIndex = workflow.indexOf(".immutable == true", publicationIndex);
  const feedIndex = workflow.indexOf("Commit updater manifest after asset verification");
  assert.ok(publicationIndex >= 0, "the draft must be explicitly published");
  assert.ok(immutableIndex > publicationIndex, "the published release must be immutable");
  assert.ok(immutableIndex < feedIndex, "immutability must be proven before feed promotion");
});

test("workflow canonicalizes release asset URLs containing SemVer build metadata", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /scripts\/release-asset-url\.mjs/);
  assert.doesNotMatch(
    workflow,
    /expected_prefix="https:\/\/github\.com\/\$GITHUB_REPOSITORY\/releases\/download\/\$RELEASE_TAG\/"/,
  );
});

test("only the Pages deployment job receives Pages and OIDC write authority", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  const publishJob = workflow.slice(
    workflow.indexOf("  publish:"),
    workflow.indexOf("  deploy-pages:"),
  );
  const deployJob = workflow.slice(workflow.indexOf("  deploy-pages:"));
  assert.doesNotMatch(publishJob, /pages: write|id-token: write/);
  assert.match(deployJob, /pages: write/);
  assert.match(deployJob, /id-token: write/);
});

test("workflow scopes updater private keys to presence-check and signer steps", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  const buildIndex = workflow.indexOf("  build:");
  const signIndex = workflow.indexOf("  sign:");
  const publishIndex = workflow.indexOf("  publish:");
  assert.doesNotMatch(
    workflow.slice(buildIndex, workflow.indexOf("  apple-sign:")),
    /ZTERM_(?:PREVIEW|STABLE)_UPDATE_SIGNING_PRIVATE_KEY/,
  );

  for (const secret of [
    "ZTERM_PREVIEW_UPDATE_SIGNING_PRIVATE_KEY",
    "ZTERM_PREVIEW_UPDATE_SIGNING_PRIVATE_KEY_PASSWORD",
    "ZTERM_STABLE_UPDATE_SIGNING_PRIVATE_KEY",
    "ZTERM_STABLE_UPDATE_SIGNING_PRIVATE_KEY_PASSWORD",
  ]) {
    const references =
      workflow.match(new RegExp(`secrets\\.${secret} \\}\\}`, "g")) ?? [];
    assert.equal(references.length, 2, `${secret} must be exposed to exactly two steps`);
  }
  const credentialCheckIndex = workflow.indexOf("Require updater signing credential", signIndex);
  const signerIndex = workflow.indexOf("Sign and verify updater archive", signIndex);
  const testIndex = workflow.indexOf("Test, lint, and audit ZTerm");
  const buildBinaryIndex = workflow.indexOf("Build release-stamped native binary");
  const appleImportIndex = workflow.indexOf("Require and import stable Apple identity");
  const packageIndex = workflow.indexOf("Package unsigned ZTerm.app");
  assert.ok(appleImportIndex > testIndex, "tests must run before unlocking Apple identity");
  assert.ok(appleImportIndex > buildBinaryIndex, "the binary must build before Apple import");
  assert.ok(packageIndex < appleImportIndex, "unsigned packaging must precede Apple credentials");
  assert.ok(credentialCheckIndex > signIndex && signerIndex > credentialCheckIndex);
  assert.ok(signerIndex < publishIndex);
  assert.match(workflow.slice(signerIndex), /STABLE_PRIVATE_KEY_PASSWORD/);
});
