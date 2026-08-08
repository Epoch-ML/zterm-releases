#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  makeReleaseAssetUrl,
  validateReleaseAssetUrl,
} from "./release-asset-url.mjs";
import { readReleaseRequest } from "./release-request.mjs";

const RELEASE_REPOSITORY = "Epoch-ML/zterm-releases";
const ARCHIVE_NAME = "ZTerm.app.tar.gz";
const SIGNATURE_NAME = `${ARCHIVE_NAME}.sig`;
const CHECKSUMS_NAME = "checksums.txt";
const LATEST_NAME = "latest.json";
const METADATA_NAME = "release-metadata.json";
const MAX_BINARY_BYTES = 512 * 1024 * 1024;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;

export class ReleasePayloadError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReleasePayloadError";
  }
}

function fail(message) {
  throw new ReleasePayloadError(message);
}

function requireRecord(value, description) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${description} must be a JSON object`);
  }
  return value;
}

function requireExactKeys(value, expectedKeys, description) {
  const record = requireRecord(value, description);
  const actual = Object.keys(record).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(`${description} must contain exactly: ${expected.join(", ")}`);
  }
  return record;
}

function requireEqual(actual, expected, description) {
  if (actual !== expected) {
    fail(`${description} does not match the immutable release request`);
  }
}

function requirePositiveInteger(value, description) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail(`${description} must be a positive integer`);
  }
  return value;
}

async function readBoundedText(path, maximumBytes, description) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    fail(`${description} cannot be read: ${error.message}`);
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    fail(`${description} must be a regular non-symlink file`);
  }
  if (metadata.size === 0 || metadata.size > maximumBytes) {
    fail(`${description} must contain 1-${maximumBytes} bytes`);
  }
  return readFile(path, "utf8");
}

async function readJson(path, maximumBytes, description) {
  const text = await readBoundedText(path, maximumBytes, description);
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`${description} is not valid JSON: ${error.message}`);
  }
}

async function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function expectedReleaseBody(request) {
  return [
    `ZTerm ${request.version} (${request.channel}).`,
    `Built from immutable Epoch-ML/zerg source commit \`${request.source_sha}\`.`,
    "The updater archive is signed independently from the macOS application signature.",
  ].join("\n\n");
}

function validateCanonicalBase64(value) {
  if (Buffer.from(value, "base64").toString("base64") !== value) {
    fail(`${SIGNATURE_NAME} must contain canonical base64`);
  }
}

function validateChecksums(text, primaryNames, hashes) {
  if (!text.endsWith("\n")) {
    fail(`${CHECKSUMS_NAME} must end with exactly one complete checksum line`);
  }
  const lines = text.slice(0, -1).split("\n");
  if (lines.length !== primaryNames.length) {
    fail(`${CHECKSUMS_NAME} must cover exactly the three primary artifacts`);
  }
  const expectedText = `${primaryNames
    .map((name) => `${hashes[name]}  ${name}`)
    .sort()
    .join("\n")}\n`;
  if (text !== expectedText) {
    fail(
      `${CHECKSUMS_NAME} does not exactly bind the three primary artifacts in canonical codepoint order`,
    );
  }
}

function validateMetadata(metadata, request, primaryNames, hashes) {
  requireExactKeys(
    metadata,
    [
      "apple_notarized",
      "artifacts",
      "bundle_identifier",
      "channel",
      "platform",
      "product",
      "schema_version",
      "source_sha",
      "version",
    ],
    METADATA_NAME,
  );
  requireEqual(metadata.schema_version, 1, `${METADATA_NAME} schema_version`);
  requireEqual(metadata.product, "ZTerm", `${METADATA_NAME} product`);
  requireEqual(metadata.version, request.version, `${METADATA_NAME} version`);
  requireEqual(metadata.channel, request.channel, `${METADATA_NAME} channel`);
  requireEqual(metadata.platform, "darwin-aarch64", `${METADATA_NAME} platform`);
  requireEqual(
    metadata.bundle_identifier,
    "dev.zerg.zterm",
    `${METADATA_NAME} bundle_identifier`,
  );
  requireEqual(
    metadata.source_sha,
    request.source_sha,
    `${METADATA_NAME} source_sha`,
  );
  requireEqual(
    metadata.apple_notarized,
    request.channel === "stable",
    `${METADATA_NAME} apple_notarized`,
  );
  if (!Array.isArray(metadata.artifacts) || metadata.artifacts.length !== 3) {
    fail(`${METADATA_NAME} must describe exactly three primary artifacts`);
  }
  for (const [index, name] of primaryNames.entries()) {
    const artifact = requireExactKeys(
      metadata.artifacts[index],
      ["name", "sha256"],
      `${METADATA_NAME} artifact ${index + 1}`,
    );
    requireEqual(artifact.name, name, `${METADATA_NAME} artifact name`);
    requireEqual(
      artifact.sha256,
      hashes[name],
      `${METADATA_NAME} ${name} sha256`,
    );
  }
}

function validateLatest(latest, request, signature, hashes, repository) {
  requireExactKeys(
    latest,
    ["notes", "platforms", "product", "pub_date", "schema_version", "version"],
    LATEST_NAME,
  );
  requireEqual(latest.schema_version, 1, `${LATEST_NAME} schema_version`);
  requireEqual(latest.product, "ZTerm", `${LATEST_NAME} product`);
  requireEqual(latest.version, request.version, `${LATEST_NAME} version`);
  requireEqual(
    latest.notes,
    `ZTerm ${request.channel} release from source ${request.source_sha}.`,
    `${LATEST_NAME} notes`,
  );
  requireEqual(latest.pub_date, request.requested_at, `${LATEST_NAME} pub_date`);
  const platforms = requireExactKeys(
    latest.platforms,
    ["darwin-aarch64"],
    `${LATEST_NAME} platforms`,
  );
  const platform = requireExactKeys(
    platforms["darwin-aarch64"],
    ["sha256", "signature", "url"],
    `${LATEST_NAME} darwin-aarch64 platform`,
  );
  requireEqual(platform.sha256, hashes[ARCHIVE_NAME], `${LATEST_NAME} sha256`);
  requireEqual(platform.signature, signature, `${LATEST_NAME} signature`);
  requireEqual(
    platform.url,
    makeReleaseAssetUrl(repository, request.release_tag, ARCHIVE_NAME),
    `${LATEST_NAME} archive URL`,
  );
}

function validateRelease(release, request, repository, names, sizes, hashes) {
  const descriptor = requireRecord(release, "GitHub release descriptor");
  const releaseId = requirePositiveInteger(descriptor.id, "GitHub release ID");
  requireEqual(descriptor.tag_name, request.release_tag, "GitHub release tag");
  requireEqual(
    descriptor.name,
    `ZTerm ${request.version} (${request.channel})`,
    "GitHub release title",
  );
  requireEqual(descriptor.body, expectedReleaseBody(request), "GitHub release body");
  requireEqual(descriptor.draft, false, "GitHub release draft state");
  requireEqual(descriptor.immutable, true, "GitHub release immutable state");
  requireEqual(
    descriptor.prerelease,
    request.channel === "preview",
    "GitHub release prerelease state",
  );
  if (!Array.isArray(descriptor.assets) || descriptor.assets.length !== names.length) {
    fail("GitHub release must contain exactly the six canonical assets");
  }

  const assetsByName = new Map();
  const assetIds = new Set();
  for (const assetValue of descriptor.assets) {
    const asset = requireRecord(assetValue, "GitHub release asset");
    if (typeof asset.name !== "string" || !names.includes(asset.name)) {
      fail(`GitHub release contains unexpected asset: ${String(asset.name)}`);
    }
    if (assetsByName.has(asset.name)) {
      fail(`GitHub release contains duplicate asset: ${asset.name}`);
    }
    const assetId = requirePositiveInteger(asset.id, `${asset.name} asset ID`);
    if (assetIds.has(assetId)) {
      fail(`GitHub release contains duplicate asset ID: ${assetId}`);
    }
    assetIds.add(assetId);
    requireEqual(asset.state, "uploaded", `${asset.name} upload state`);
    requireEqual(asset.size, sizes[asset.name], `${asset.name} API size`);
    requireEqual(
      asset.digest,
      `sha256:${hashes[asset.name]}`,
      `${asset.name} API digest`,
    );
    requireEqual(
      asset.url,
      `https://api.github.com/repos/${repository}/releases/assets/${assetId}`,
      `${asset.name} API URL`,
    );
    let canonicalUrl;
    try {
      canonicalUrl = validateReleaseAssetUrl(
        asset.browser_download_url,
        repository,
        request.release_tag,
        asset.name,
      );
    } catch (error) {
      fail(`${asset.name} browser download URL is invalid: ${error.message}`);
    }
    requireEqual(
      asset.browser_download_url,
      canonicalUrl,
      `${asset.name} browser download URL`,
    );
    assetsByName.set(asset.name, asset);
  }
  return releaseId;
}

export async function verifyReleasePayload({
  payloadDir,
  releaseJsonPath,
  requestPath,
  repository,
}) {
  if (repository !== RELEASE_REPOSITORY) {
    fail(`release repository must equal ${RELEASE_REPOSITORY}`);
  }
  let request;
  try {
    request = await readReleaseRequest(requestPath);
  } catch (error) {
    fail(`immutable release request is invalid: ${error.message}`);
  }
  const dmgName = `ZTerm_${request.version}_aarch64.dmg`;
  const primaryNames = [ARCHIVE_NAME, SIGNATURE_NAME, dmgName];
  const names = [
    ...primaryNames,
    CHECKSUMS_NAME,
    LATEST_NAME,
    METADATA_NAME,
  ];

  let directoryMetadata;
  try {
    directoryMetadata = await lstat(payloadDir);
  } catch (error) {
    fail(`verified release directory cannot be read: ${error.message}`);
  }
  if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory()) {
    fail("verified release path must be a regular non-symlink directory");
  }
  const entries = await readdir(payloadDir, { withFileTypes: true });
  if (
    entries.length !== names.length ||
    entries.some((entry) => !names.includes(entry.name))
  ) {
    fail(`verified release directory must contain exactly: ${names.join(", ")}`);
  }

  const sizes = {};
  let totalBytes = 0;
  for (const name of names) {
    const metadata = await lstat(join(payloadDir, name));
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      fail(`${name} must be a regular non-symlink file`);
    }
    if (metadata.size <= 0) {
      fail(`${name} must not be empty`);
    }
    let maximumBytes = MAX_JSON_BYTES;
    if (name === ARCHIVE_NAME || name === dmgName) {
      maximumBytes = MAX_BINARY_BYTES;
    } else if (name === SIGNATURE_NAME || name === CHECKSUMS_NAME) {
      maximumBytes = MAX_TEXT_BYTES;
    }
    if (metadata.size > maximumBytes) {
      fail(`${name} exceeds its ${maximumBytes}-byte verification bound`);
    }
    sizes[name] = metadata.size;
    totalBytes += metadata.size;
    if (totalBytes >= MAX_TOTAL_BYTES) {
      fail(`canonical asset set reaches its ${MAX_TOTAL_BYTES}-byte total bound`);
    }
  }
  const hashEntries = await Promise.all(
    names.map(async (name) => [name, await sha256File(join(payloadDir, name))]),
  );
  const hashes = Object.fromEntries(hashEntries);

  const release = await readJson(
    releaseJsonPath,
    MAX_JSON_BYTES,
    "GitHub release descriptor",
  );
  const releaseId = validateRelease(
    release,
    request,
    repository,
    names,
    sizes,
    hashes,
  );

  const checksumText = await readBoundedText(
    join(payloadDir, CHECKSUMS_NAME),
    MAX_TEXT_BYTES,
    CHECKSUMS_NAME,
  );
  validateChecksums(checksumText, primaryNames, hashes);
  const signature = await readBoundedText(
    join(payloadDir, SIGNATURE_NAME),
    MAX_TEXT_BYTES,
    SIGNATURE_NAME,
  );
  validateCanonicalBase64(signature);
  const metadata = await readJson(
    join(payloadDir, METADATA_NAME),
    MAX_JSON_BYTES,
    METADATA_NAME,
  );
  validateMetadata(metadata, request, primaryNames, hashes);
  const latest = await readJson(
    join(payloadDir, LATEST_NAME),
    MAX_JSON_BYTES,
    LATEST_NAME,
  );
  validateLatest(latest, request, signature, hashes, repository);

  return {
    assetSha256: hashes,
    releaseId,
    releaseTag: request.release_tag,
  };
}

async function main() {
  const [payloadDir, releaseJsonPath, requestPath, repository] =
    process.argv.slice(2);
  if (
    process.argv.length !== 6 ||
    [payloadDir, releaseJsonPath, requestPath, repository].some(
      (value) => typeof value !== "string" || value.length === 0,
    )
  ) {
    fail(
      "usage: verify-release-payload.mjs PAYLOAD_DIR RELEASE.json REQUEST.json REPOSITORY",
    );
  }
  const result = await verifyReleasePayload({
    payloadDir,
    releaseJsonPath,
    requestPath,
    repository,
  });
  process.stdout.write(
    `verified immutable ${result.releaseTag} release ${result.releaseId}\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`verify-release-payload: ${error.message}`);
    process.exitCode = 1;
  });
}
