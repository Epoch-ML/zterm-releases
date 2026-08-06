import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  deployPages,
  MAX_DEPLOY_TIMEOUT_MS,
  PagesDeploymentError,
  runPagesDeploymentFromEnvironment,
} from "./deploy-pages.mjs";

const BUILD_VERSION = "a".repeat(40);
const DEPLOYMENT_ID = "deployment-123";
const OIDC_URL = "https://oidc.example.test/token";
const API_URL = "https://api.github.test";
const PAGE_URL = "https://epoch-ml.github.io/zterm-releases/";

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

function deploymentOptions(overrides = {}) {
  return {
    apiUrl: API_URL,
    artifactId: "8968529654",
    buildVersion: BUILD_VERSION,
    githubToken: "github-token",
    oidcRequestToken: "oidc-request-token",
    oidcRequestUrl: OIDC_URL,
    repository: "Epoch-ML/zterm-releases",
    timeoutMs: String(MAX_DEPLOY_TIMEOUT_MS),
    ...overrides,
  };
}

function fakeDeployment(
  statuses,
  { deploymentId = DEPLOYMENT_ID, initialTime = 1_000_000 } = {},
) {
  const requests = [];
  let currentTime = initialTime;
  let statusIndex = 0;
  const fetchImpl = async (url, options = {}) => {
    const request = {
      body: options.body,
      headers: options.headers,
      method: options.method ?? "GET",
      url: String(url),
    };
    requests.push(request);
    if (request.url === OIDC_URL) {
      return jsonResponse({ value: "pages-oidc-token" });
    }
    if (request.method === "POST") {
      return jsonResponse({
        id: deploymentId,
        page_url: PAGE_URL,
      });
    }
    const status = statuses[Math.min(statusIndex, statuses.length - 1)];
    statusIndex += 1;
    if (typeof status === "number") {
      return jsonResponse({ message: "temporary service error" }, status);
    }
    if (status !== null && typeof status === "object") {
      return jsonResponse(status);
    }
    return jsonResponse({ status });
  };
  return {
    dependencies: {
      fetchImpl,
      logger: { info() {}, warn() {} },
      now: () => currentTime,
      sleep: async (duration) => {
        currentTime += duration;
      },
    },
    elapsed: () => currentTime - initialTime,
    requests,
  };
}

test("queued Pages deployment can succeed after the upstream ten-minute ceiling", async () => {
  const fake = fakeDeployment([
    "deployment_queued",
    "deployment_queued",
    "deployment_queued",
    "succeed",
  ]);
  const result = await deployPages(deploymentOptions(), {
    ...fake.dependencies,
    pollIntervalMs: 5 * 60 * 1000,
  });

  assert.deepEqual(result, {
    deploymentId: DEPLOYMENT_ID,
    pageUrl: PAGE_URL,
  });
  assert.equal(fake.elapsed(), 15 * 60 * 1000);
  const createRequest = fake.requests.find((request) => request.method === "POST");
  assert.deepEqual(JSON.parse(createRequest.body), {
    artifact_id: 8968529654,
    oidc_token: "pages-oidc-token",
    pages_build_version: BUILD_VERSION,
  });
  assert.deepEqual(fake.requests[0], {
    body: undefined,
    headers: {
      Accept: "application/json",
      Authorization: "Bearer oidc-request-token",
    },
    method: "GET",
    url: OIDC_URL,
  });
  assert.equal(
    createRequest.url,
    "https://api.github.test/repos/Epoch-ML/zterm-releases/pages/deployments",
  );
  assert.deepEqual(createRequest.headers, {
    Accept: "application/vnd.github+json",
    Authorization: "Bearer github-token",
    "Content-Type": "application/json",
    "User-Agent": "zterm-pages-deployer",
    "X-GitHub-Api-Version": "2022-11-28",
  });
  const statusRequests = fake.requests.filter(
    (request) => request.method === "GET" && request.url !== OIDC_URL,
  );
  assert.equal(statusRequests.length, 4);
  assert.equal(
    statusRequests[0].url,
    `https://api.github.test/repos/Epoch-ML/zterm-releases/pages/deployments/${DEPLOYMENT_ID}`,
  );
  assert.equal(statusRequests[0].headers["Content-Type"], undefined);
  assert.equal(
    fake.requests.some((request) => request.url.endsWith("/cancel")),
    false,
  );
});

test("local timeout leaves the keyed Pages deployment active for an idempotent retry", async () => {
  const fake = fakeDeployment(["deployment_queued"]);

  await assert.rejects(
    deployPages(deploymentOptions(), {
      ...fake.dependencies,
      pollIntervalMs: 11 * 60 * 1000,
    }),
    (error) =>
      error instanceof PagesDeploymentError &&
      error.message ===
        `Pages deployment ${DEPLOYMENT_ID} is still pending after ${MAX_DEPLOY_TIMEOUT_MS}ms; ` +
          "it was left active for a safe retry",
  );
  assert.equal(fake.elapsed(), MAX_DEPLOY_TIMEOUT_MS);
  assert.equal(
    fake.requests.some((request) => request.url.endsWith("/cancel")),
    false,
  );
});

test(
  "terminal Pages status and repeated API failures are rejected with specific errors",
  async () => {
    for (const [status, message] of [
      ["deployment_failed", "deployment failed"],
      ["deployment_content_failed", "deployment content failed validation"],
      ["deployment_cancelled", "deployment was cancelled"],
      ["deployment_lost", "deployment stopped reporting status"],
    ]) {
      const terminal = fakeDeployment([status]);
      await assert.rejects(
        deployPages(deploymentOptions(), terminal.dependencies),
        new RegExp(`Pages deployment ${DEPLOYMENT_ID} ${message}`),
      );
    }

    const unavailable = fakeDeployment([503]);
    await assert.rejects(
      deployPages(deploymentOptions(), {
        ...unavailable.dependencies,
        pollIntervalMs: 1,
        statusErrorLimit: 2,
      }),
      /status failed 2 consecutive times: Pages deployment status returned HTTP 503/,
    );

    const recovered = fakeDeployment([
      503,
      "deployment_queued",
      503,
      "succeed",
    ]);
    const result = await deployPages(deploymentOptions(), {
      ...recovered.dependencies,
      pollIntervalMs: 1,
      statusErrorLimit: 2,
    });
    assert.equal(result.deploymentId, DEPLOYMENT_ID);

    for (const malformedStatus of [{}, { status: "" }, { status: null }]) {
      const malformed = fakeDeployment([malformedStatus]);
      await assert.rejects(
        deployPages(deploymentOptions(), {
          ...malformed.dependencies,
          statusErrorLimit: 1,
        }),
        /status failed 1 consecutive times: Pages deployment status response is missing status/,
      );
    }
  },
);

test("deployment inputs are bounded before any credential-bearing request", async () => {
  for (const overrides of [
    { artifactId: "0" },
    { artifactId: "1.5" },
    { artifactId: "not-an-id" },
    { buildVersion: "main" },
    { buildVersion: "" },
    { githubToken: "" },
    { repository: "Epoch-ML" },
    { repository: "" },
    { timeoutMs: "0" },
    { timeoutMs: String(MAX_DEPLOY_TIMEOUT_MS + 1) },
    { apiUrl: "http://api.github.test" },
    { apiUrl: "not-a-url" },
    { oidcRequestUrl: "" },
    { oidcRequestToken: "" },
  ]) {
    let requestCount = 0;
    await assert.rejects(
      deployPages(deploymentOptions(overrides), {
        fetchImpl: async () => {
          requestCount += 1;
          return jsonResponse({});
        },
      }),
      PagesDeploymentError,
    );
    assert.equal(requestCount, 0);
  }

  await assert.rejects(
    deployPages(deploymentOptions(), { fetchImpl: null }),
    /fetch implementation is unavailable/,
  );
  await assert.rejects(
    deployPages(deploymentOptions(), { pollIntervalMs: 0 }),
    /Pages poll interval must be an integer between/,
  );
  await assert.rejects(
    deployPages(deploymentOptions(), { statusErrorLimit: 101 }),
    /Pages status error limit must be an integer between 1 and 100/,
  );
});

test("credential and deployment API responses fail closed", async () => {
  for (const [response, message] of [
    [new Response("", { status: 200 }), /OIDC token returned an invalid response/],
    [new Response("not-json", { status: 200 }), /OIDC token returned malformed JSON/],
    [jsonResponse([], 200), /OIDC token returned an invalid response/],
    [jsonResponse({}, 200), /OIDC token response value must be a non-empty string/],
    [jsonResponse({ message: "denied" }, 403), /OIDC token returned HTTP 403: denied/],
    [jsonResponse({ message: 403 }, 403), /OIDC token returned HTTP 403$/],
  ]) {
    await assert.rejects(
      deployPages(deploymentOptions(), {
        fetchImpl: async () => response,
      }),
      message,
    );
  }

  await assert.rejects(
    deployPages(deploymentOptions(), {
      fetchImpl: async () => {
        throw new Error("network unavailable");
      },
    }),
    /OIDC token request failed: network unavailable/,
  );

  for (const response of [
    new Response("", { status: 200 }),
    jsonResponse([], 200),
    jsonResponse({ message: "invalid artifact" }, 422),
  ]) {
    let requestCount = 0;
    await assert.rejects(
      deployPages(deploymentOptions(), {
        fetchImpl: async () => {
          requestCount += 1;
          return requestCount === 1
            ? jsonResponse({ value: "pages-oidc-token" })
            : response;
        },
      }),
      PagesDeploymentError,
    );
    assert.equal(requestCount, 2);
  }
});

test("workflow environment writes the exact deployed HTTPS root to its step output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zterm-pages-output-"));
  const outputPath = join(directory, "github-output");
  const fake = fakeDeployment(["succeed"]);
  try {
    const result = await runPagesDeploymentFromEnvironment(
      {
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-request-token",
        ACTIONS_ID_TOKEN_REQUEST_URL: OIDC_URL,
        GITHUB_OUTPUT: outputPath,
        GITHUB_REPOSITORY: "Epoch-ML/zterm-releases",
        GITHUB_SHA: BUILD_VERSION,
        GITHUB_TOKEN: "github-token",
        PAGES_ARTIFACT_ID: "8968529654",
        PAGES_DEPLOY_TIMEOUT_MS: String(MAX_DEPLOY_TIMEOUT_MS),
      },
      fake.dependencies,
    );

    assert.equal(result.pageUrl, PAGE_URL);
    assert.equal(await readFile(outputPath, "utf8"), `page_url=${PAGE_URL}\n`);
    assert.equal(
      fake.requests.find((request) => request.method === "POST").url,
      "https://api.github.com/repos/Epoch-ML/zterm-releases/pages/deployments",
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
