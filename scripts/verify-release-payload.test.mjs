import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { makeReleaseAssetUrl } from "./release-asset-url.mjs";
import {
  ReleasePayloadError,
  verifyReleasePayload,
} from "./verify-release-payload.mjs";

const REPOSITORY = "Epoch-ML/zterm-releases";
const execFileAsync = promisify(execFile);
const REQUEST = {
  schema_version: 1,
  product: "ZTerm",
  channel: "preview",
  version: "1.2.3-preview.4",
  release_tag: "zterm-preview-v1.2.3-preview.4",
  source_repository: "Epoch-ML/zerg",
  source_sha: "0123456789abcdef0123456789abcdef01234567",
  source_ref: "refs/tags/zterm-preview-v1.2.3-preview.4",
  requested_at: "2026-08-06T10:04:05.000Z",
};

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function synchronizeReleaseAsset(fixture, name) {
  const bytes = await readFile(join(fixture.payloadDir, name));
  const release = JSON.parse(await readFile(fixture.releaseJsonPath, "utf8"));
  const asset = release.assets.find((candidate) => candidate.name === name);
  asset.size = bytes.length;
  asset.digest = `sha256:${sha256(bytes)}`;
  await writeFile(fixture.releaseJsonPath, `${JSON.stringify(release, null, 2)}\n`);
}

async function mutateRelease(fixture, mutate) {
  const release = JSON.parse(await readFile(fixture.releaseJsonPath, "utf8"));
  mutate(release);
  await writeFile(fixture.releaseJsonPath, `${JSON.stringify(release, null, 2)}\n`);
}

async function mutateJsonAsset(fixture, name, mutate) {
  const path = join(fixture.payloadDir, name);
  const value = JSON.parse(await readFile(path, "utf8"));
  mutate(value);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
  await synchronizeReleaseAsset(fixture, name);
}

async function replaceSignature(fixture, signature) {
  const signatureName = "ZTerm.app.tar.gz.sig";
  const signaturePath = join(fixture.payloadDir, signatureName);
  await writeFile(signaturePath, signature);
  const signatureHash = sha256(signature);

  const checksumsPath = join(fixture.payloadDir, "checksums.txt");
  const checksums = await readFile(checksumsPath, "utf8");
  await writeFile(
    checksumsPath,
    checksums.replace(
      new RegExp(`^[0-9a-f]{64}  ${signatureName.replaceAll(".", "\\.")}$`, "m"),
      `${signatureHash}  ${signatureName}`,
    )
      .trimEnd()
      .split("\n")
      .sort()
      .join("\n") + "\n",
  );
  await mutateJsonAsset(fixture, "release-metadata.json", (metadata) => {
    metadata.artifacts.find((artifact) => artifact.name === signatureName).sha256 =
      signatureHash;
  });
  await mutateJsonAsset(fixture, "latest.json", (latest) => {
    latest.platforms["darwin-aarch64"].signature = signature;
  });
  await synchronizeReleaseAsset(fixture, signatureName);
  await synchronizeReleaseAsset(fixture, "checksums.txt");
}

async function expectPayloadError(fixture, expectedMessage, repository = REPOSITORY) {
  await assert.rejects(
    verifyReleasePayload({ ...fixture, repository }),
    (error) => {
      assert.equal(error.name, ReleasePayloadError.name);
      assert.match(error.message, expectedMessage);
      return true;
    },
  );
}

async function makeFixture(t, request = REQUEST) {
  const root = await mkdtemp(join(tmpdir(), "zterm-release-payload-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const payloadDir = join(root, "payload");
  const requestPath = join(root, "request.json");
  const releaseJsonPath = join(root, "release.json");
  await mkdir(payloadDir);
  await writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`);

  const archiveName = "ZTerm.app.tar.gz";
  const signatureName = "ZTerm.app.tar.gz.sig";
  const dmgName = `ZTerm_${request.version}_aarch64.dmg`;
  const signature = Buffer.from(
    "untrusted comment: signature from fixture\nfixture-signature-bytes\n",
  ).toString("base64");
  const primary = {
    [archiveName]: Buffer.from("signed ZTerm archive fixture"),
    [signatureName]: Buffer.from(signature),
    [dmgName]: Buffer.from("signed ZTerm disk image fixture"),
  };
  const primaryHashes = Object.fromEntries(
    Object.entries(primary).map(([name, bytes]) => [name, sha256(bytes)]),
  );
  for (const [name, bytes] of Object.entries(primary)) {
    await writeFile(join(payloadDir, name), bytes);
  }
  await writeFile(
    join(payloadDir, "checksums.txt"),
    [archiveName, signatureName, dmgName]
      .map((name) => `${primaryHashes[name]}  ${name}\n`)
      .join(""),
  );
  await writeFile(
    join(payloadDir, "release-metadata.json"),
    `${JSON.stringify(
      {
        schema_version: 1,
        product: "ZTerm",
        version: request.version,
        channel: request.channel,
        platform: "darwin-aarch64",
        bundle_identifier: "dev.zerg.zterm",
        source_sha: request.source_sha,
        apple_notarized: request.channel === "stable",
        artifacts: [archiveName, signatureName, dmgName].map((name) => ({
          name,
          sha256: primaryHashes[name],
        })),
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(payloadDir, "latest.json"),
    `${JSON.stringify(
      {
        schema_version: 1,
        product: "ZTerm",
        version: request.version,
        notes: `ZTerm ${request.channel} release from source ${request.source_sha}.`,
        pub_date: request.requested_at,
        platforms: {
          "darwin-aarch64": {
            sha256: primaryHashes[archiveName],
            signature,
            url: makeReleaseAssetUrl(
              REPOSITORY,
              request.release_tag,
              archiveName,
            ),
          },
        },
      },
      null,
      2,
    )}\n`,
  );

  const releaseAssets = [];
  let id = 100;
  for (const name of (await readdir(payloadDir)).sort().reverse()) {
    const bytes = await readFile(join(payloadDir, name));
    releaseAssets.push({
      id,
      name,
      size: bytes.length,
      state: "uploaded",
      digest: `sha256:${sha256(bytes)}`,
      url: `https://api.github.com/repos/${REPOSITORY}/releases/assets/${id}`,
      browser_download_url: makeReleaseAssetUrl(
        REPOSITORY,
        request.release_tag,
        name,
      ),
    });
    id += 1;
  }
  await writeFile(
    releaseJsonPath,
    `${JSON.stringify(
      {
        id: 42,
        tag_name: request.release_tag,
        name: `ZTerm ${request.version} (${request.channel})`,
        body: [
          `ZTerm ${request.version} (${request.channel}).`,
          `Built from immutable Epoch-ML/zerg source commit \`${request.source_sha}\`.`,
          "The updater archive is signed independently from the macOS application signature.",
        ].join("\n\n"),
        draft: false,
        prerelease: request.channel === "preview",
        immutable: true,
        assets: releaseAssets,
      },
      null,
      2,
    )}\n`,
  );
  return { payloadDir, releaseJsonPath, request, requestPath, root };
}

test("verifies every canonical public release byte against all release contracts", async (t) => {
  const fixture = await makeFixture(t);
  const result = await verifyReleasePayload({
    ...fixture,
    repository: REPOSITORY,
  });

  assert.equal(result.releaseId, 42);
  assert.equal(result.releaseTag, REQUEST.release_tag);
  assert.equal(
    result.assetSha256["ZTerm.app.tar.gz"],
    sha256("signed ZTerm archive fixture"),
  );
});

test("verifies the stable release identity and notarization contract", async (t) => {
  const stableRequest = {
    ...REQUEST,
    channel: "stable",
    version: "1.2.3",
    release_tag: "zterm-v1.2.3",
    source_ref: "refs/tags/zterm-v1.2.3",
  };
  const fixture = await makeFixture(t, stableRequest);
  const result = await verifyReleasePayload({
    ...fixture,
    repository: REPOSITORY,
  });

  assert.equal(result.releaseTag, "zterm-v1.2.3");
  assert.equal(result.assetSha256["ZTerm_1.2.3_aarch64.dmg"].length, 64);
});

test("verification CLI reports the immutable release identity", async (t) => {
  const fixture = await makeFixture(t);
  const script = new URL("./verify-release-payload.mjs", import.meta.url);
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    script.pathname,
    fixture.payloadDir,
    fixture.releaseJsonPath,
    fixture.requestPath,
    REPOSITORY,
  ]);
  assert.equal(stderr, "");
  assert.equal(
    stdout,
    `verified immutable ${REQUEST.release_tag} release 42\n`,
  );

  await assert.rejects(
    execFileAsync(process.execPath, [script.pathname]),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /usage: verify-release-payload\.mjs/);
      return true;
    },
  );
});

test("rejects a plausible but incorrect GitHub API digest", async (t) => {
  const fixture = await makeFixture(t);
  const release = JSON.parse(await readFile(fixture.releaseJsonPath, "utf8"));
  release.assets.find((asset) => asset.name === "ZTerm.app.tar.gz").digest =
    `sha256:${"0".repeat(64)}`;
  await writeFile(fixture.releaseJsonPath, JSON.stringify(release));

  await assert.rejects(
    verifyReleasePayload({ ...fixture, repository: REPOSITORY }),
    (error) => {
      assert.equal(error.name, ReleasePayloadError.name);
      assert.match(error.message, /ZTerm\.app\.tar\.gz API digest/);
      return true;
    },
  );
});

test("rejects an oversized immutable archive before hashing or extraction", async (t) => {
  const fixture = await makeFixture(t);
  const archive = await open(join(fixture.payloadDir, "ZTerm.app.tar.gz"), "r+");
  await archive.truncate(512 * 1024 * 1024 + 1);
  await archive.close();

  await assert.rejects(
    verifyReleasePayload({ ...fixture, repository: REPOSITORY }),
    (error) => {
      assert.equal(error.name, ReleasePayloadError.name);
      assert.match(error.message, /ZTerm\.app\.tar\.gz exceeds its .* verification bound/);
      return true;
    },
  );
});

test("enforces exact directory, file, and aggregate byte bounds", async (t) => {
  {
    const fixture = await makeFixture(t);
    await writeFile(join(fixture.payloadDir, "unexpected.txt"), "unexpected");
    await expectPayloadError(fixture, /must contain exactly/);
  }
  {
    const fixture = await makeFixture(t);
    await writeFile(join(fixture.payloadDir, `ZTerm_${REQUEST.version}_aarch64.dmg`), "");
    await expectPayloadError(fixture, /must not be empty/);
  }
  {
    const fixture = await makeFixture(t);
    const originalPayload = join(fixture.root, "original-payload");
    await rename(fixture.payloadDir, originalPayload);
    await symlink(originalPayload, fixture.payloadDir);
    await expectPayloadError(fixture, /regular non-symlink directory/);
  }
  {
    const fixture = await makeFixture(t);
    await expectPayloadError(
      { ...fixture, payloadDir: fixture.requestPath },
      /regular non-symlink directory/,
    );
  }
  {
    const fixture = await makeFixture(t);
    await rm(join(fixture.payloadDir, "latest.json"));
    await expectPayloadError(fixture, /must contain exactly/);
  }
  {
    const fixture = await makeFixture(t);
    await rm(join(fixture.payloadDir, "latest.json"));
    await writeFile(join(fixture.payloadDir, "unexpected.json"), "unexpected");
    await expectPayloadError(fixture, /must contain exactly/);
  }
  {
    const fixture = await makeFixture(t);
    await rm(join(fixture.payloadDir, "latest.json"));
    await mkdir(join(fixture.payloadDir, "latest.json"));
    await expectPayloadError(fixture, /latest\.json must be a regular non-symlink file/);
  }
  {
    const fixture = await makeFixture(t);
    for (const name of [
      "ZTerm.app.tar.gz",
      `ZTerm_${REQUEST.version}_aarch64.dmg`,
    ]) {
      const handle = await open(join(fixture.payloadDir, name), "r+");
      await handle.truncate(512 * 1024 * 1024);
      await handle.close();
    }
    await expectPayloadError(fixture, /canonical asset set reaches its .* total bound/);
  }
});

test("rejects a canonical asset set at the exact aggregate boundary", async (t) => {
  const fixture = await makeFixture(t);
  const archiveName = "ZTerm.app.tar.gz";
  const dmgName = `ZTerm_${REQUEST.version}_aarch64.dmg`;
  const boundedNames = [
    "ZTerm.app.tar.gz.sig",
    "checksums.txt",
    "latest.json",
    "release-metadata.json",
  ];
  let boundedBytes = 0;
  for (const name of boundedNames) {
    boundedBytes += (await stat(join(fixture.payloadDir, name))).size;
  }
  const binaryBytes = 1024 * 1024 * 1024 - boundedBytes;
  const archiveBytes = Math.floor(binaryBytes / 2);
  for (const [name, size] of [
    [archiveName, archiveBytes],
    [dmgName, binaryBytes - archiveBytes],
  ]) {
    const handle = await open(join(fixture.payloadDir, name), "r+");
    await handle.truncate(size);
    await handle.close();
  }

  await expectPayloadError(fixture, /canonical asset set reaches its .* total bound/);
});

test("accepts a canonical signature at the exact text-size boundary", async (t) => {
  const fixture = await makeFixture(t);
  const boundarySignature = "A".repeat(64 * 1024);
  await replaceSignature(fixture, boundarySignature);

  const result = await verifyReleasePayload({
    ...fixture,
    repository: REPOSITORY,
  });
  assert.equal(
    result.assetSha256["ZTerm.app.tar.gz.sig"],
    sha256(boundarySignature),
  );
});

test("rejects a canonical signature above the text-size boundary", async (t) => {
  const fixture = await makeFixture(t);
  await replaceSignature(fixture, "A".repeat(64 * 1024 + 4));
  await expectPayloadError(
    fixture,
    /ZTerm\.app\.tar\.gz\.sig exceeds its .* verification bound/,
  );
});

test("rejects checksums above the text-size boundary", async (t) => {
  const fixture = await makeFixture(t);
  await writeFile(
    join(fixture.payloadDir, "checksums.txt"),
    "A".repeat(64 * 1024 + 1),
  );
  await expectPayloadError(
    fixture,
    /checksums\.txt exceeds its .* verification bound/,
  );
});

test("rejects noncanonical signature and checksum encodings", async (t) => {
  {
    const fixture = await makeFixture(t);
    await replaceSignature(fixture, "AAAA=");
    await expectPayloadError(fixture, /must contain canonical base64/);
  }
  {
    const fixture = await makeFixture(t);
    const checksumsPath = join(fixture.payloadDir, "checksums.txt");
    const checksums = await readFile(checksumsPath, "utf8");
    await writeFile(checksumsPath, checksums.replace("\n", " trailing\n"));
    await synchronizeReleaseAsset(fixture, "checksums.txt");
    await expectPayloadError(fixture, /does not exactly bind/);
  }
  {
    const fixture = await makeFixture(t);
    const checksumsPath = join(fixture.payloadDir, "checksums.txt");
    await writeFile(
      checksumsPath,
      `${await readFile(checksumsPath, "utf8")}0${"0".repeat(63)}  extra\n`,
    );
    await synchronizeReleaseAsset(fixture, "checksums.txt");
    await expectPayloadError(fixture, /exactly the three primary artifacts/);
  }
  {
    const fixture = await makeFixture(t);
    const checksumsPath = join(fixture.payloadDir, "checksums.txt");
    const checksums = await readFile(checksumsPath, "utf8");
    await writeFile(checksumsPath, checksums.slice(0, -1));
    await synchronizeReleaseAsset(fixture, "checksums.txt");
    await expectPayloadError(fixture, /must end with exactly one complete checksum line/);
  }
  {
    const fixture = await makeFixture(t);
    const checksumsPath = join(fixture.payloadDir, "checksums.txt");
    const checksums = await readFile(checksumsPath, "utf8");
    await writeFile(checksumsPath, `junk${checksums}`);
    await synchronizeReleaseAsset(fixture, "checksums.txt");
    await expectPayloadError(fixture, /does not exactly bind/);
  }
});

test("accepts only the workflow's canonical codepoint checksum order", async (t) => {
  {
    const fixture = await makeFixture(t);
    await replaceSignature(fixture, "AAAA");
    const checksumsPath = join(fixture.payloadDir, "checksums.txt");
    const sortedChecksums = (await readFile(checksumsPath, "utf8"))
      .trimEnd()
      .split("\n")
      .sort()
      .join("\n");
    await writeFile(checksumsPath, `${sortedChecksums}\n`);
    await synchronizeReleaseAsset(fixture, "checksums.txt");

    const result = await verifyReleasePayload({ ...fixture, repository: REPOSITORY });
    assert.equal(result.releaseId, 42);
    assert.equal(result.assetSha256["ZTerm.app.tar.gz.sig"], sha256("AAAA"));
  }
  {
    const fixture = await makeFixture(t);
    await replaceSignature(fixture, "AAAA");
    const checksumsPath = join(fixture.payloadDir, "checksums.txt");
    const canonicalLines = (await readFile(checksumsPath, "utf8"))
      .trimEnd()
      .split("\n");
    await writeFile(checksumsPath, `${canonicalLines.reverse().join("\n")}\n`);
    await synchronizeReleaseAsset(fixture, "checksums.txt");
    await expectPayloadError(fixture, /canonical codepoint order/);
  }
});

test("rejects drift in release metadata and updater manifests", async (t) => {
  {
    const fixture = await makeFixture(t);
    await mutateJsonAsset(fixture, "release-metadata.json", (metadata) => {
      metadata.unexpected = true;
    });
    await expectPayloadError(fixture, /release-metadata\.json must contain exactly/);
  }
  {
    const fixture = await makeFixture(t);
    await mutateJsonAsset(fixture, "release-metadata.json", (metadata) => {
      delete metadata.version;
    });
    await expectPayloadError(fixture, /release-metadata\.json must contain exactly/);
  }
  {
    const fixture = await makeFixture(t);
    await mutateJsonAsset(fixture, "release-metadata.json", (metadata) => {
      delete metadata.version;
      metadata.zzzz = REQUEST.version;
    });
    await expectPayloadError(fixture, /release-metadata\.json must contain exactly/);
  }
  {
    const fixture = await makeFixture(t);
    await mutateJsonAsset(fixture, "release-metadata.json", (metadata) => {
      metadata.artifacts.pop();
    });
    await expectPayloadError(fixture, /exactly three primary artifacts/);
  }
  {
    const fixture = await makeFixture(t);
    await mutateJsonAsset(fixture, "release-metadata.json", (metadata) => {
      metadata.artifacts[0].sha256 = "f".repeat(64);
    });
    await expectPayloadError(fixture, /ZTerm\.app\.tar\.gz sha256/);
  }
  {
    const fixture = await makeFixture(t);
    await mutateJsonAsset(fixture, "latest.json", (latest) => {
      latest.pub_date = "2026-08-06T10:04:06.000Z";
    });
    await expectPayloadError(fixture, /latest\.json pub_date/);
  }
  {
    const fixture = await makeFixture(t);
    await mutateJsonAsset(fixture, "latest.json", (latest) => {
      latest.platforms["darwin-aarch64"].url =
        "https://github.com/Epoch-ML/zterm-releases/releases/download/wrong/ZTerm.app.tar.gz";
    });
    await expectPayloadError(fixture, /latest\.json archive URL/);
  }
});

test("rejects malformed release and asset descriptor identities", async (t) => {
  const cases = [
    [(release) => (release.id = 0), /GitHub release ID/],
    [(release) => (release.draft = true), /GitHub release draft state/],
    [(release) => (release.prerelease = false), /GitHub release prerelease state/],
    [(release) => (release.assets = null), /exactly the six canonical assets/],
    [
      (release) => release.assets.push({ ...release.assets[0], id: 999 }),
      /exactly the six canonical assets/,
    ],
    [(release) => (release.assets[0] = null), /GitHub release asset must be a JSON object/],
    [(release) => (release.assets[0].name = 7), /contains unexpected asset/],
    [
      (release) => (release.assets[0].name = "unexpected.bin"),
      /contains unexpected asset/,
    ],
    [
      (release) => (release.assets[1].name = release.assets[0].name),
      /contains duplicate asset/,
    ],
    [
      (release) => (release.assets[1].id = release.assets[0].id),
      /duplicate asset ID/,
    ],
    [(release) => (release.assets[0].size += 1), /API size/],
    [(release) => (release.assets[0].state = "new"), /upload state/],
    [(release) => (release.assets[0].url += "/escaped"), /API URL/],
  ];
  for (const [mutate, expectedMessage] of cases) {
    const fixture = await makeFixture(t);
    await mutateRelease(fixture, mutate);
    await expectPayloadError(fixture, expectedMessage);
  }

  const fixture = await makeFixture(t);
  await expectPayloadError(fixture, /release repository must equal/, "attacker/repo");
});

test("rejects unreadable, nonregular, empty, and malformed release descriptors", async (t) => {
  {
    const fixture = await makeFixture(t);
    await writeFile(fixture.releaseJsonPath, "null");
    await expectPayloadError(fixture, /GitHub release descriptor must be a JSON object/);
  }
  {
    const fixture = await makeFixture(t);
    await writeFile(fixture.releaseJsonPath, "[]");
    await expectPayloadError(fixture, /GitHub release descriptor must be a JSON object/);
  }
  {
    const fixture = await makeFixture(t);
    await rm(fixture.releaseJsonPath);
    await symlink(fixture.requestPath, fixture.releaseJsonPath);
    await expectPayloadError(fixture, /regular non-symlink file/);
  }
  {
    const fixture = await makeFixture(t);
    await expectPayloadError(
      { ...fixture, releaseJsonPath: fixture.payloadDir },
      /regular non-symlink file/,
    );
  }
  {
    const fixture = await makeFixture(t);
    await writeFile(fixture.releaseJsonPath, "");
    await expectPayloadError(fixture, /must contain 1-/);
  }
  {
    const fixture = await makeFixture(t);
    await writeFile(fixture.releaseJsonPath, "{");
    await expectPayloadError(fixture, /is not valid JSON/);
  }
  {
    const fixture = await makeFixture(t);
    await writeFile(fixture.releaseJsonPath, " ".repeat(1024 * 1024 + 1));
    await expectPayloadError(fixture, /must contain 1-/);
  }
  {
    const fixture = await makeFixture(t);
    await rm(fixture.releaseJsonPath);
    await expectPayloadError(fixture, /cannot be read/);
  }
});

test("wraps missing payload and invalid immutable request failures", async (t) => {
  {
    const fixture = await makeFixture(t);
    await expectPayloadError(
      { ...fixture, payloadDir: join(fixture.root, "missing-payload") },
      /verified release directory cannot be read/,
    );
  }
  {
    const fixture = await makeFixture(t);
    await writeFile(fixture.requestPath, "{");
    await expectPayloadError(fixture, /immutable release request is invalid/);
  }
});

test("rejects a canonical asset replaced by a symbolic link", async (t) => {
  const fixture = await makeFixture(t);
  const latestPath = join(fixture.payloadDir, "latest.json");
  await rm(latestPath);
  await symlink(fixture.releaseJsonPath, latestPath);

  await assert.rejects(
    verifyReleasePayload({ ...fixture, repository: REPOSITORY }),
    (error) => {
      assert.equal(error.name, ReleasePayloadError.name);
      assert.match(error.message, /latest\.json must be a regular non-symlink file/);
      return true;
    },
  );
});

test("rejects checksums that do not bind the downloaded archive", async (t) => {
  const fixture = await makeFixture(t);
  const checksumsPath = join(fixture.payloadDir, "checksums.txt");
  const checksums = await readFile(checksumsPath, "utf8");
  await writeFile(checksumsPath, checksums.replace(/^[0-9a-f]{64}/, "f".repeat(64)));
  await synchronizeReleaseAsset(fixture, "checksums.txt");

  await assert.rejects(
    verifyReleasePayload({ ...fixture, repository: REPOSITORY }),
    (error) => {
      assert.equal(error.name, ReleasePayloadError.name);
      assert.match(error.message, /checksums\.txt does not exactly bind/);
      return true;
    },
  );
});

test("rejects release metadata that weakens the preview notarization claim", async (t) => {
  const fixture = await makeFixture(t);
  const metadataPath = join(fixture.payloadDir, "release-metadata.json");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  metadata.apple_notarized = true;
  await writeFile(metadataPath, JSON.stringify(metadata));
  await synchronizeReleaseAsset(fixture, "release-metadata.json");

  await assert.rejects(
    verifyReleasePayload({ ...fixture, repository: REPOSITORY }),
    (error) => {
      assert.equal(error.name, ReleasePayloadError.name);
      assert.match(error.message, /apple_notarized/);
      return true;
    },
  );
});

test("rejects a mutable release even when every asset hash matches", async (t) => {
  const fixture = await makeFixture(t);
  const release = JSON.parse(await readFile(fixture.releaseJsonPath, "utf8"));
  release.immutable = false;
  await writeFile(fixture.releaseJsonPath, JSON.stringify(release));

  await assert.rejects(
    verifyReleasePayload({ ...fixture, repository: REPOSITORY }),
    (error) => {
      assert.equal(error.name, ReleasePayloadError.name);
      assert.match(error.message, /GitHub release immutable state/);
      return true;
    },
  );
});

test("rejects a release asset URL outside the exact repository and tag", async (t) => {
  const fixture = await makeFixture(t);
  const release = JSON.parse(await readFile(fixture.releaseJsonPath, "utf8"));
  release.assets.find((asset) => asset.name === "latest.json").browser_download_url =
    "https://github.com/attacker/zterm-releases/releases/download/wrong/latest.json";
  await writeFile(fixture.releaseJsonPath, JSON.stringify(release));

  await assert.rejects(
    verifyReleasePayload({ ...fixture, repository: REPOSITORY }),
    (error) => {
      assert.equal(error.name, ReleasePayloadError.name);
      assert.match(error.message, /latest\.json browser download URL is invalid/);
      return true;
    },
  );
});
