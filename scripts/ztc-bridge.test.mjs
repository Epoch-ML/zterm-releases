import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const POLICY_SHA = 'bedcdd03c6358268253ad8bf8d465427ee90c69e';
// An absent workflow is an empty contract, so the first run reports the missing
// public behavior rather than a filesystem setup error.
const workflow = await readFile(new URL('../.github/workflows/ztc-bridge.yml', import.meta.url), 'utf8').catch((error) => {
  if (error.code === 'ENOENT') return '';
  throw error;
});
const job = (name) => {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  const remaining = workflow.slice(start + 1);
  const next = remaining.slice(1).search(/\n  [a-z][a-z-]+:\n/);
  return start < 0 ? '' : next < 0 ? remaining : remaining.slice(0, next + 1);
};

test('bridge emits signed artifacts without publishing or changing either feed', () => {
  const jobs = [...workflow.slice(workflow.indexOf('jobs:')).matchAll(/^  ([a-z][a-z-]+):$/gm)].map((match) => match[1]);
  assert.deepEqual(jobs, ['validate', 'build', 'apple-sign', 'verify-signed', 'sign']);
  assert.doesNotMatch(workflow, /contents: write|pages: write|id-token: write|git push|gh release|ZTERM_FEED_DEPLOY_KEY/);
  assert.match(job('sign'), /name: \$\{\{ needs\.validate\.outputs\.release_tag \}\}[\s\S]*path: payload\//);
  assert.match(workflow, /group: zterm-desktop-release\n  cancel-in-progress: false/);
});

test('bridge accepts only protected-main dispatches and validates the new repository request history', () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /workflow_call:|repository_dispatch:|pull_request:/);
  assert.match(job('validate'), /GITHUB_REPOSITORY.*Epoch-ML\/zterm-releases/);
  assert.match(job('validate'), /GITHUB_REF.*refs\/heads\/main/);
  assert.match(job('validate'), /working-directory: request-index/);
  assert.match(job('validate'), /git merge-base --is-ancestor "\$request_commit" "\$\(git rev-parse HEAD\)"/);
  assert.match(job('validate'), /the request addition commit must add only this request/);
  assert.match(job('validate'), /public release tag must point to the immutable request addition commit/);
  assert.match(job('validate'), /node \.\.\/release-index\/scripts\/release-request\.mjs "\$candidate"/);
});

test('all executable publisher policy is pinned, and mutable request data is checked out separately', () => {
  const checkouts = [...workflow.matchAll(/- uses: actions\/checkout@[^\n]+\n        with:\n([\s\S]*?)(?=\n      -|$)/g)].map((match) => match[1]);
  assert.equal(checkouts.length, 6);
  for (const checkout of checkouts) {
    assert.match(checkout, /repository: Epoch-ML\/ztc-releases/);
    assert.match(checkout, /persist-credentials: false/);
    const requestData = checkout.includes('path: request-index');
    assert.match(checkout, requestData ? /ref: (main|\$\{\{ needs\.validate\.outputs\.release_target_sha \}\})/ : new RegExp(`ref: ${POLICY_SHA}`));
  }
  assert.doesNotMatch(workflow, /node request-index\/|npm .*--prefix request-index|working-directory: request-index\n[\s\S]{0,20}run: npm/);
  assert.match(job('sign'), /ref: \$\{\{ needs\.validate\.outputs\.release_target_sha \}\}/);
  assert.match(job('sign'), /build-public-release\.mjs "request-index\/requests\/\$RELEASE_TAG\.json"/);
});

test('signing reuses legacy protected environments while both channels require Apple notarization', () => {
  assert.match(job('build'), /environment: zterm-source/);
  assert.match(job('apple-sign'), /environment:\n      name: zterm-apple-stable/);
  assert.match(job('sign'), /name: zterm-updater-\$\{\{ needs\.validate\.outputs\.channel \}\}/);
  assert.match(job('apple-sign'), /xcrun notarytool submit "\$app_zip"/);
  assert.match(job('apple-sign'), /xcrun notarytool submit "\$dmg"/);
  assert.match(job('apple-sign'), /source=Notarized Developer ID/);
  assert.match(job('verify-signed'), /xcrun stapler validate "\$app"/);
  assert.match(job('verify-signed'), /xcrun stapler validate "\$dmg"/);
  assert.match(job('sign'), /needs:\n      - validate\n      - apple-sign\n      - verify-signed/);
  assert.doesNotMatch(job('apple-sign'), /npm ci|working-directory: source|node source\/|--version/);
  assert.doesNotMatch(job('verify-signed'), /secrets\./);
});

test('every published URL points to the new ZTC repository rather than the signing host', () => {
  const signer = job('sign');
  assert.match(signer, /release-asset-url\.mjs \\\n              "Epoch-ML\/ztc-releases" "\$RELEASE_TAG" "\$archive_name"/);
  assert.doesNotMatch(signer, /"\$GITHUB_REPOSITORY"/);
  assert.match(signer, /product: "ZTC"/);
  assert.match(signer, /minisign -Vm payload\/release\.json/);
  assert.match(signer, /minisign -Vm payload\/ztc\.app\.tar\.gz/);
});
