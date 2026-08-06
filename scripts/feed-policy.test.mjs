import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  compareSemver,
  FeedPolicyError,
  validateFeedPromotion,
  validateImmutableMetadata,
} from "./feed-policy.mjs";

function manifest(version, sha256 = "a".repeat(64)) {
  return `${JSON.stringify({
    schema_version: 1,
    product: "ZTerm",
    version,
    notes: "fixture",
    pub_date: "2026-08-06T20:00:00.000Z",
    platforms: {
      "darwin-aarch64": {
        sha256,
        signature: "signature",
        url: "https://github.com/Epoch-ML/zterm-releases/releases/download/tag/ZTerm.app.tar.gz",
      },
    },
  }, null, 2)}\n`;
}

test("SemVer comparison orders prerelease identifiers and ignores build precedence", () => {
  const ordered = [
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-alpha.beta",
    "1.0.0-beta",
    "1.0.0-beta.2",
    "1.0.0-beta.11",
    "1.0.0-rc.1",
    "1.0.0",
    "1.0.1",
  ];
  for (let index = 1; index < ordered.length; index += 1) {
    assert.equal(compareSemver(ordered[index - 1], ordered[index]), -1);
    assert.equal(compareSemver(ordered[index], ordered[index - 1]), 1);
  }
  assert.equal(compareSemver("1.0.0+one", "1.0.0+two"), 0);
  assert.equal(compareSemver("1.0.0-12", "1.0.0-2"), 1);
  assert.equal(compareSemver("1.0.0-2", "1.0.0-12"), -1);
  assert.equal(compareSemver("1.0.0-10", "1.0.0-2"), 1);
  assert.equal(compareSemver("1.0.0-2", "1.0.0-10"), -1);
  assert.equal(compareSemver("1.0.0-9", "1.0.0-1a"), -1);
  assert.equal(compareSemver("1.0.0-1a", "1.0.0-9"), 1);
  assert.equal(compareSemver("1.0.0-a1", "1.0.0-9"), 1);
  assert.equal(compareSemver("1.0.0-9", "1.0.0-a1"), -1);
});

test("SemVer comparison rejects malformed operands with side-specific errors", () => {
  for (const value of [null, "", "1.0", "01.0.0", "1.0.0-01"]) {
    assert.throws(
      () => compareSemver(value, "1.0.0"),
      (error) =>
        error instanceof FeedPolicyError &&
        error.message === "left version must be strict SemVer",
    );
    assert.throws(
      () => compareSemver("1.0.0", value),
      (error) =>
        error instanceof FeedPolicyError &&
        error.message === "right version must be strict SemVer",
    );
  }
});

test("feed promotion accepts only a strictly newer version or exact retry bytes", () => {
  assert.equal(validateFeedPromotion(null, manifest("0.2.0-preview.1")), "publish");
  assert.equal(
    validateFeedPromotion(
      manifest("0.2.0-preview.1"),
      manifest("0.2.0-preview.2"),
    ),
    "publish",
  );
  const identical = manifest("0.2.0-preview.2");
  assert.equal(validateFeedPromotion(identical, identical), "unchanged");
});

test("feed promotion rejects rollback and same-precedence byte conflicts", () => {
  assert.throws(
    () =>
      validateFeedPromotion(
        manifest("0.2.0-preview.2"),
        manifest("0.2.0-preview.1"),
      ),
    (error) => error instanceof FeedPolicyError && /rollback/.test(error.message),
  );
  assert.throws(
    () =>
      validateFeedPromotion(
        manifest("0.2.0-preview.2"),
        manifest("0.2.0-preview.2", "b".repeat(64)),
      ),
    /conflicts with the existing immutable bytes/,
  );
  assert.throws(
    () =>
      validateFeedPromotion(
        manifest("1.0.0+build.1"),
        manifest("1.0.0+build.2"),
      ),
    /conflicts with the existing immutable bytes/,
  );
});

test("feed promotion rejects malformed JSON and non-ZTerm feed identities", () => {
  assert.throws(
    () => validateFeedPromotion(null, "{not-json}"),
    /candidate manifest is not valid JSON/,
  );
  for (const invalid of [
    null,
    [],
    { schema_version: 2, product: "ZTerm", version: "1.0.0" },
    { schema_version: 1, product: "Other", version: "1.0.0" },
  ]) {
    assert.throws(
      () => validateFeedPromotion(null, `${JSON.stringify(invalid)}\n`),
      /candidate manifest is not a ZTerm v1 feed/,
    );
  }
  assert.throws(
    () => validateFeedPromotion(manifest("not-semver"), manifest("1.0.0")),
    /existing version must be strict SemVer/,
  );
});

test("per-version release metadata is immutable across retries", () => {
  assert.equal(validateImmutableMetadata(null, "candidate\n"), "publish");
  assert.equal(
    validateImmutableMetadata("candidate\n", "candidate\n"),
    "unchanged",
  );
  assert.throws(
    () => validateImmutableMetadata("old\n", "candidate\n"),
    /metadata.*conflicts/,
  );
});

test("feed policy CLI permits missing destinations but requires regular candidates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zterm-feed-policy-"));
  try {
    const candidateFeed = join(directory, "candidate-latest.json");
    const candidateMetadata = join(directory, "candidate-metadata.json");
    const missingFeed = join(directory, "missing-latest.json");
    const missingMetadata = join(directory, "missing-metadata.json");
    await writeFile(candidateFeed, manifest("1.0.0"));
    await writeFile(candidateMetadata, '{"version":"1.0.0"}\n');
    const accepted = spawnSync(
      process.execPath,
      [
        new URL("./feed-policy.mjs", import.meta.url).pathname,
        missingFeed,
        candidateFeed,
        missingMetadata,
        candidateMetadata,
      ],
      { encoding: "utf8" },
    );
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(accepted.stdout, "feed=publish metadata=publish\n");

    const missingCandidate = spawnSync(
      process.execPath,
      [
        new URL("./feed-policy.mjs", import.meta.url).pathname,
        missingFeed,
        join(directory, "absent-candidate.json"),
        missingMetadata,
        candidateMetadata,
      ],
      { encoding: "utf8" },
    );
    assert.equal(missingCandidate.status, 1);
    assert.match(missingCandidate.stderr, /ENOENT/);

    const linkedCandidate = join(directory, "linked-candidate.json");
    await symlink(candidateFeed, linkedCandidate);
    const symlinked = spawnSync(
      process.execPath,
      [
        new URL("./feed-policy.mjs", import.meta.url).pathname,
        missingFeed,
        linkedCandidate,
        missingMetadata,
        candidateMetadata,
      ],
      { encoding: "utf8" },
    );
    assert.equal(symlinked.status, 1);
    assert.match(symlinked.stderr, /regular non-symlink file/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
