#!/usr/bin/env node

import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const MAX_DEPLOY_TIMEOUT_MS = 30 * 60 * 1000;

const DEFAULT_POLL_INTERVAL_MS = 5 * 1000;
const DEFAULT_STATUS_ERROR_LIMIT = 10;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TERMINAL_FAILURES = new Map([
  ["deployment_failed", "deployment failed"],
  ["deployment_content_failed", "deployment content failed validation"],
  ["deployment_cancelled", "deployment was cancelled"],
  ["deployment_lost", "deployment stopped reporting status"],
]);

export class PagesDeploymentError extends Error {
  constructor(message) {
    super(message);
    this.name = "PagesDeploymentError";
  }
}

function requireNonEmptyString(value, description) {
  if (typeof value !== "string" || value.length === 0) {
    throw new PagesDeploymentError(`${description} must be a non-empty string`);
  }
  return value;
}

function requirePositiveInteger(value, description, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new PagesDeploymentError(
      `${description} must be an integer between 1 and ${maximum}`,
    );
  }
  return parsed;
}

function requireHttpsUrl(value, description) {
  const raw = requireNonEmptyString(value, description);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new PagesDeploymentError(`${description} must be a valid HTTPS URL`);
  }
  if (parsed.protocol !== "https:") {
    throw new PagesDeploymentError(`${description} must be a valid HTTPS URL`);
  }
  return parsed;
}

async function requestJson(fetchImpl, url, options, description) {
  let response;
  try {
    response = await fetchImpl(url, options);
  } catch (error) {
    throw new PagesDeploymentError(`${description} request failed: ${error.message}`);
  }

  const content = await response.text();
  let payload = null;
  if (content.length > 0) {
    try {
      payload = JSON.parse(content);
    } catch {
      throw new PagesDeploymentError(
        `${description} returned malformed JSON with HTTP ${response.status}`,
      );
    }
  }
  if (!response.ok) {
    const detail =
      payload !== null && typeof payload.message === "string"
        ? `: ${payload.message}`
        : "";
    throw new PagesDeploymentError(
      `${description} returned HTTP ${response.status}${detail}`,
    );
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new PagesDeploymentError(`${description} returned an invalid response`);
  }
  return payload;
}

async function getOidcToken({ fetchImpl, requestUrl, requestToken }) {
  const oidcUrl = requireHttpsUrl(requestUrl, "OIDC request URL");
  const token = requireNonEmptyString(requestToken, "OIDC request token");
  const payload = await requestJson(
    fetchImpl,
    oidcUrl,
    {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
    },
    "OIDC token",
  );
  return requireNonEmptyString(payload.value, "OIDC token response value");
}

function githubHeaders(githubToken, includeJson = false) {
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${githubToken}`,
    "User-Agent": "zterm-pages-deployer",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (includeJson) headers["Content-Type"] = "application/json";
  return headers;
}

function parseDeploymentStatus(payload) {
  if (typeof payload.status !== "string" || payload.status.length === 0) {
    throw new PagesDeploymentError("Pages deployment status response is missing status");
  }
  return payload.status;
}

export async function deployPages(
  {
    apiUrl,
    artifactId,
    buildVersion,
    githubToken,
    oidcRequestToken,
    oidcRequestUrl,
    repository,
    timeoutMs,
  },
  {
    fetchImpl = globalThis.fetch,
    logger = console,
    now = Date.now,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    sleep = (duration) => new Promise((resolve) => setTimeout(resolve, duration)),
    statusErrorLimit = DEFAULT_STATUS_ERROR_LIMIT,
  } = {},
) {
  if (typeof fetchImpl !== "function") {
    throw new PagesDeploymentError("fetch implementation is unavailable");
  }
  const apiRoot = requireHttpsUrl(apiUrl, "GitHub API URL");
  const artifact = requirePositiveInteger(artifactId, "Pages artifact ID");
  const commit = requireNonEmptyString(buildVersion, "Pages build version");
  if (!SHA_PATTERN.test(commit)) {
    throw new PagesDeploymentError(
      "Pages build version must be a 40-character lowercase commit SHA",
    );
  }
  const repositoryName = requireNonEmptyString(repository, "GitHub repository");
  if (!REPOSITORY_PATTERN.test(repositoryName)) {
    throw new PagesDeploymentError("GitHub repository must use owner/name form");
  }
  const token = requireNonEmptyString(githubToken, "GitHub token");
  const timeout = requirePositiveInteger(
    timeoutMs,
    "Pages deployment timeout",
    MAX_DEPLOY_TIMEOUT_MS,
  );
  const pollInterval = requirePositiveInteger(
    pollIntervalMs,
    "Pages poll interval",
    timeout,
  );
  const errorLimit = requirePositiveInteger(
    statusErrorLimit,
    "Pages status error limit",
    100,
  );
  const [owner, name] = repositoryName.split("/").map(encodeURIComponent);
  const deploymentsUrl = new URL(
    `repos/${owner}/${name}/pages/deployments`,
    `${apiRoot.href.replace(/\/$/, "")}/`,
  );
  const oidcToken = await getOidcToken({
    fetchImpl,
    requestToken: oidcRequestToken,
    requestUrl: oidcRequestUrl,
  });
  const deployment = await requestJson(
    fetchImpl,
    deploymentsUrl,
    {
      body: JSON.stringify({
        artifact_id: artifact,
        oidc_token: oidcToken,
        pages_build_version: commit,
      }),
      headers: githubHeaders(token, true),
      method: "POST",
    },
    "Pages deployment creation",
  );
  const deploymentId = requireNonEmptyString(
    deployment.id ?? commit,
    "Pages deployment ID",
  );
  const pageUrl = requireHttpsUrl(deployment.page_url, "Pages deployment URL").href;
  const statusUrl = new URL(
    `repos/${owner}/${name}/pages/deployments/${encodeURIComponent(deploymentId)}`,
    `${apiRoot.href.replace(/\/$/, "")}/`,
  );
  const startedAt = now();
  let statusErrors = 0;

  while (true) {
    let status;
    try {
      const statusPayload = await requestJson(
        fetchImpl,
        statusUrl,
        { headers: githubHeaders(token) },
        "Pages deployment status",
      );
      status = parseDeploymentStatus(statusPayload);
      statusErrors = 0;
    } catch (error) {
      statusErrors += 1;
      if (statusErrors >= errorLimit) {
        throw new PagesDeploymentError(
          `Pages deployment status failed ${statusErrors} consecutive times: ${error.message}`,
        );
      }
      logger.warn(`Pages deployment status retry ${statusErrors}: ${error.message}`);
    }

    if (status === "succeed") {
      logger.info(`Pages deployment ${deploymentId} succeeded.`);
      return { deploymentId, pageUrl };
    }
    if (TERMINAL_FAILURES.has(status)) {
      throw new PagesDeploymentError(
        `Pages deployment ${deploymentId} ${TERMINAL_FAILURES.get(status)}`,
      );
    }
    if (status !== undefined) {
      logger.info(`Pages deployment ${deploymentId} status: ${status}`);
    }

    const elapsed = now() - startedAt;
    if (elapsed >= timeout) {
      throw new PagesDeploymentError(
        `Pages deployment ${deploymentId} is still pending after ${timeout}ms; ` +
          "it was left active for a safe retry",
      );
    }
    await sleep(Math.min(pollInterval, timeout - elapsed));
  }
}

export async function runPagesDeploymentFromEnvironment(
  environment = process.env,
  dependencies = {},
) {
  const result = await deployPages(
    {
      apiUrl: environment.GITHUB_API_URL ?? "https://api.github.com",
      artifactId: environment.PAGES_ARTIFACT_ID,
      buildVersion: environment.GITHUB_SHA,
      githubToken: environment.GITHUB_TOKEN,
      oidcRequestToken: environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
      oidcRequestUrl: environment.ACTIONS_ID_TOKEN_REQUEST_URL,
      repository: environment.GITHUB_REPOSITORY,
      timeoutMs: environment.PAGES_DEPLOY_TIMEOUT_MS,
    },
    dependencies,
  );
  const outputPath = requireNonEmptyString(environment.GITHUB_OUTPUT, "GitHub output path");
  await appendFile(outputPath, `page_url=${result.pageUrl}\n`, { encoding: "utf8" });
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runPagesDeploymentFromEnvironment().catch((error) => {
    console.error(`deploy-pages: ${error.message}`);
    process.exitCode = 1;
  });
}
