#!/usr/bin/env node

import { lstat, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const MAX_POLICY_FILE_BYTES = 256 * 1024;
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export class FeedPolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = "FeedPolicyError";
  }
}

function parseVersion(value, description) {
  if (typeof value !== "string") {
    throw new FeedPolicyError(`${description} version must be strict SemVer`);
  }
  const match = SEMVER_PATTERN.exec(value);
  if (match === null) {
    throw new FeedPolicyError(`${description} version must be strict SemVer`);
  }
  return {
    core: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])],
    prerelease: match[4] === undefined ? [] : match[4].split("."),
  };
}

function compareIdentifiers(left, right) {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) {
    const leftValue = BigInt(left);
    const rightValue = BigInt(right);
    return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
  }
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareSemver(left, right) {
  const leftVersion = parseVersion(left, "left");
  const rightVersion = parseVersion(right, "right");
  for (let index = 0; index < leftVersion.core.length; index += 1) {
    if (leftVersion.core[index] < rightVersion.core[index]) return -1;
    if (leftVersion.core[index] > rightVersion.core[index]) return 1;
  }
  if (leftVersion.prerelease.length === 0 || rightVersion.prerelease.length === 0) {
    if (leftVersion.prerelease.length === rightVersion.prerelease.length) return 0;
    return leftVersion.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(
    leftVersion.prerelease.length,
    rightVersion.prerelease.length,
  );
  for (let index = 0; index < length; index += 1) {
    if (leftVersion.prerelease[index] === undefined) return -1;
    if (rightVersion.prerelease[index] === undefined) return 1;
    const comparison = compareIdentifiers(
      leftVersion.prerelease[index],
      rightVersion.prerelease[index],
    );
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function parseManifest(content, description) {
  let manifest;
  try {
    manifest = JSON.parse(content);
  } catch (error) {
    throw new FeedPolicyError(`${description} manifest is not valid JSON: ${error.message}`);
  }
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    manifest.schema_version !== 1 ||
    manifest.product !== "ZTerm"
  ) {
    throw new FeedPolicyError(`${description} manifest is not a ZTerm v1 feed`);
  }
  parseVersion(manifest.version, description);
  return manifest;
}

export function validateFeedPromotion(existingContent, candidateContent) {
  const candidate = parseManifest(candidateContent, "candidate");
  if (existingContent === null) return "publish";
  const existing = parseManifest(existingContent, "existing");
  const comparison = compareSemver(candidate.version, existing.version);
  if (comparison < 0) {
    throw new FeedPolicyError(
      `feed rollback from ${existing.version} to ${candidate.version} is forbidden`,
    );
  }
  if (comparison === 0) {
    if (candidateContent !== existingContent) {
      throw new FeedPolicyError(
        `feed version ${candidate.version} conflicts with the existing immutable bytes`,
      );
    }
    return "unchanged";
  }
  return "publish";
}

export function validateImmutableMetadata(existingContent, candidateContent) {
  if (existingContent !== null && existingContent !== candidateContent) {
    throw new FeedPolicyError(
      "release metadata for this version conflicts with existing immutable bytes",
    );
  }
  return existingContent === null ? "publish" : "unchanged";
}

async function readBoundedRegularFile(path, { optional = false } = {}) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (optional && error.code === "ENOENT") return null;
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new FeedPolicyError(`${path} must be a regular non-symlink file`);
  }
  if (metadata.size > MAX_POLICY_FILE_BYTES) {
    throw new FeedPolicyError(`${path} exceeds ${MAX_POLICY_FILE_BYTES} bytes`);
  }
  return readFile(path, "utf8");
}

async function main() {
  if (process.argv.length !== 6) {
    throw new FeedPolicyError(
      "usage: feed-policy.mjs EXISTING_FEED CANDIDATE_FEED EXISTING_METADATA CANDIDATE_METADATA",
    );
  }
  const [existingFeedPath, candidateFeedPath, existingMetadataPath, candidateMetadataPath] =
    process.argv.slice(2);
  const [existingFeed, candidateFeed, existingMetadata, candidateMetadata] =
    await Promise.all([
      readBoundedRegularFile(existingFeedPath, { optional: true }),
      readBoundedRegularFile(candidateFeedPath),
      readBoundedRegularFile(existingMetadataPath, { optional: true }),
      readBoundedRegularFile(candidateMetadataPath),
    ]);
  const feedAction = validateFeedPromotion(existingFeed, candidateFeed);
  const metadataAction = validateImmutableMetadata(existingMetadata, candidateMetadata);
  process.stdout.write(`feed=${feedAction} metadata=${metadataAction}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`feed-policy: ${error.message}`);
    process.exitCode = 1;
  });
}
