#!/usr/bin/env node

import { pathToFileURL } from "node:url";

export class ReleaseAssetUrlError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReleaseAssetUrlError";
  }
}

function expectedSegments(repository, tag, assetName) {
  const repositoryParts = repository.split("/");
  if (
    repositoryParts.length !== 2 ||
    repositoryParts.some((part) => !/^[0-9A-Za-z_.-]+$/.test(part))
  ) {
    throw new ReleaseAssetUrlError("release repository must use owner/name");
  }
  for (const [value, description] of [
    [tag, "release tag"],
    [assetName, "asset name"],
  ]) {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value === "." ||
      value === ".." ||
      value.includes("/") ||
      value.includes("\\")
    ) {
      throw new ReleaseAssetUrlError(`${description} must be one safe URL segment`);
    }
  }
  return [
    ...repositoryParts,
    "releases",
    "download",
    tag,
    assetName,
  ];
}

function canonicalUrl(segments) {
  return `https://github.com/${segments.map(encodeURIComponent).join("/")}`;
}

export function makeReleaseAssetUrl(repository, tag, assetName) {
  return canonicalUrl(expectedSegments(repository, tag, assetName));
}

export function validateReleaseAssetUrl(urlValue, repository, tag, assetName) {
  const expected = expectedSegments(repository, tag, assetName);
  let url;
  try {
    url = new URL(urlValue);
  } catch {
    throw new ReleaseAssetUrlError("release asset URL must be valid HTTPS");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new ReleaseAssetUrlError(
      "release asset URL must target github.com over plain HTTPS",
    );
  }
  let actual;
  try {
    actual = url.pathname.split("/").slice(1).map(decodeURIComponent);
  } catch {
    throw new ReleaseAssetUrlError("release asset URL has invalid path encoding");
  }
  if (
    actual.length !== expected.length ||
    actual.some((segment, index) => segment !== expected[index])
  ) {
    throw new ReleaseAssetUrlError(
      "release asset URL does not match the exact repository, tag, and asset",
    );
  }
  return canonicalUrl(expected);
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 3) {
    process.stdout.write(`${makeReleaseAssetUrl(...args)}\n`);
    return;
  }
  if (args.length === 4) {
    process.stdout.write(`${validateReleaseAssetUrl(...args)}\n`);
    return;
  }
  throw new ReleaseAssetUrlError(
    "usage: release-asset-url.mjs [URL] REPOSITORY TAG ASSET",
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`release-asset-url: ${error.message}`);
    process.exitCode = 1;
  }
}
