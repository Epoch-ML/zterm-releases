import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repository = "Epoch-ML/zterm-releases";
const releaseTag = "zterm-preview-v0.1.2-preview.1";

async function runReleaseLookup(t, scenario) {
  const workflow = await readFile(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  const verificationStep = workflow.indexOf(
    "Validate release metadata and compare every published asset over HTTPS",
  );
  const functionStart = workflow.indexOf("          fetch_exact_release() {", verificationStep);
  const functionEnd = workflow.indexOf(
    '          release_json="$RUNNER_TEMP/release.json"',
    functionStart,
  );
  assert.notEqual(verificationStep, -1, "release verification step must exist");
  assert.notEqual(functionStart, -1, "release lookup function must exist");
  assert.notEqual(functionEnd, -1, "release lookup function must have a bounded end");

  const lookupFunction = workflow
    .slice(functionStart, functionEnd)
    .replace(/^ {10}/gm, "");
  const root = await mkdtemp(join(tmpdir(), "zterm-release-visibility-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  const outputPath = join(root, "release.json");
  const statePath = join(root, "attempt");
  const callLogPath = join(root, "gh-calls");
  const sleepLogPath = join(root, "sleep-calls");
  await mkdir(bin);

  const fakeGh = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >>"$LOOKUP_CALLS"
[[ "$1" == "api" ]]
endpoint="$2"
if [[ "$endpoint" == "repos/$GITHUB_REPOSITORY/releases?per_page=100&page=1" ]]; then
  attempt=0
  if [[ -f "$LOOKUP_STATE" ]]; then
    attempt="$(<"$LOOKUP_STATE")"
  fi
  attempt=$((attempt + 1))
  printf '%s\\n' "$attempt" >"$LOOKUP_STATE"
  case "$LOOKUP_SCENARIO" in
    eventual)
      if [[ "$attempt" -eq 1 ]]; then
        printf '[]\\n'
      else
        printf '[{"id":42,"tag_name":"%s"}]\\n' "$RELEASE_TAG"
      fi
      ;;
    duplicate)
      printf '[{"id":42,"tag_name":"%s"},{"id":43,"tag_name":"%s"}]\\n' "$RELEASE_TAG" "$RELEASE_TAG"
      ;;
    persistent-zero)
      printf '[]\\n'
      ;;
    *)
      exit 91
      ;;
  esac
elif [[ "$endpoint" == "repos/$GITHUB_REPOSITORY/releases/42" ]]; then
  printf '{"id":42,"tag_name":"%s"}\\n' "$RELEASE_TAG"
else
  exit 92
fi
`;
  const fakeSleep = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$1" >>"$LOOKUP_SLEEPS"
`;
  await writeFile(join(bin, "gh"), fakeGh, { mode: 0o700 });
  await writeFile(join(bin, "sleep"), fakeSleep, { mode: 0o700 });
  await chmod(join(bin, "gh"), 0o700);
  await chmod(join(bin, "sleep"), 0o700);

  const result = spawnSync(
    "bash",
    ["-c", `${lookupFunction}\nfetch_exact_release "$OUTPUT_PATH"\n`],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_REPOSITORY: repository,
        LOOKUP_CALLS: callLogPath,
        LOOKUP_SCENARIO: scenario,
        LOOKUP_SLEEPS: sleepLogPath,
        LOOKUP_STATE: statePath,
        OUTPUT_PATH: outputPath,
        PATH: `${bin}:${process.env.PATH}`,
        RELEASE_TAG: releaseTag,
        RUNNER_TEMP: root,
      },
    },
  );
  const calls = (await readFile(callLogPath, "utf8")).trim().split("\n");
  const sleeps = await readFile(sleepLogPath, "utf8")
    .then((value) => value.trim().split("\n"))
    .catch((error) => {
      if (error.code === "ENOENT") {
        return [];
      }
      throw error;
    });
  const output = await readFile(outputPath, "utf8").catch((error) => {
    if (error.code === "ENOENT") {
      return "";
    }
    throw error;
  });
  return { calls, output, result, sleeps };
}

test("exact release lookup tolerates one list API visibility miss", async (t) => {
  const { calls, output, result, sleeps } = await runReleaseLookup(t, "eventual");
  const diagnostics = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.status, 0, diagnostics);
  assert.deepEqual(JSON.parse(output), { id: 42, tag_name: releaseTag });
  assert.deepEqual(calls, [
    `api repos/${repository}/releases?per_page=100&page=1`,
    `api repos/${repository}/releases?per_page=100&page=1`,
    `api repos/${repository}/releases/42`,
  ]);
  assert.deepEqual(sleeps, ["5"]);
});

test("exact release lookup fails closed on duplicate releases without retrying", async (t) => {
  const { calls, result, sleeps } = await runReleaseLookup(t, "duplicate");
  const diagnostics = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(diagnostics, /expected exactly one release.*found 2/);
  assert.deepEqual(calls, [`api repos/${repository}/releases?per_page=100&page=1`]);
  assert.deepEqual(sleeps, []);
});

test("exact release lookup stops after the bounded visibility window", async (t) => {
  const { calls, result, sleeps } = await runReleaseLookup(t, "persistent-zero");
  const diagnostics = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(diagnostics, /after 12 attempts; found 0/);
  assert.equal(calls.length, 12);
  assert.deepEqual(sleeps, Array(11).fill("5"));
});
