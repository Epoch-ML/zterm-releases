import assert from "node:assert/strict";
import test from "node:test";

import {
  makeReleaseAssetUrl,
  ReleaseAssetUrlError,
  validateReleaseAssetUrl,
} from "./release-asset-url.mjs";

const REPOSITORY = "Epoch-ML/zterm-releases";
const TAG = "zterm-preview-v1.2.3+build.7";
const ASSET = "ZTerm.app.tar.gz";
const CANONICAL =
  "https://github.com/Epoch-ML/zterm-releases/releases/download/zterm-preview-v1.2.3%2Bbuild.7/ZTerm.app.tar.gz";

test("build-metadata tags produce one canonical encoded release asset URL", () => {
  assert.equal(makeReleaseAssetUrl(REPOSITORY, TAG, ASSET), CANONICAL);
  assert.equal(validateReleaseAssetUrl(CANONICAL, REPOSITORY, TAG, ASSET), CANONICAL);
  assert.equal(
    validateReleaseAssetUrl(
      CANONICAL.replace("%2B", "+"),
      REPOSITORY,
      TAG,
      ASSET,
    ),
    CANONICAL,
  );
});

test("release URL validation pins every authority and path component", () => {
  for (const url of [
    "not-a-url",
    CANONICAL.replace("https:", "http:"),
    CANONICAL.replace("github.com", "example.test"),
    CANONICAL.replace("github.com", "user@github.com"),
    CANONICAL.replace("github.com", "user:password@github.com"),
    CANONICAL.replace("github.com", "github.com:444"),
    `${CANONICAL}?download=1`,
    `${CANONICAL}#fragment`,
    CANONICAL.replace("Epoch-ML", "Other"),
    CANONICAL.replace("%2Bbuild.7", "%2Fbuild.7"),
    CANONICAL.replace(ASSET, "Other.app.tar.gz"),
    `${CANONICAL}/extra`,
    CANONICAL.replace("%2B", "%"),
  ]) {
    assert.throws(
      () => validateReleaseAssetUrl(url, REPOSITORY, TAG, ASSET),
      (error) => error instanceof ReleaseAssetUrlError && error.message.length > 20,
    );
  }
});

test("release URL generation rejects unsafe repository, tag, and asset segments", () => {
  for (const repository of [
    "one/two/three",
    "/zterm-releases",
    "Epoch-ML/",
    "Epoch ML/zterm-releases",
    "Epoch-ML/zterm-releases@",
  ]) {
    assert.throws(
      () => makeReleaseAssetUrl(repository, TAG, ASSET),
      /repository must use owner\/name/,
    );
  }
  for (const tag of [null, "", ".", "..", "../tag", "tag\\other"]) {
    assert.throws(
      () => makeReleaseAssetUrl(REPOSITORY, tag, ASSET),
      (error) =>
        error instanceof ReleaseAssetUrlError &&
        error.message === "release tag must be one safe URL segment",
    );
  }
  for (const asset of [null, "", ".", "..", "../asset", "asset\\other"]) {
    assert.throws(
      () => makeReleaseAssetUrl(REPOSITORY, TAG, asset),
      (error) =>
        error instanceof ReleaseAssetUrlError &&
        error.message === "asset name must be one safe URL segment",
    );
  }
});
