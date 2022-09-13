const core = require("@actions/core");
const process = require("process");
const HttpClient = require("@actions/http-client").HttpClient;
const { createLogger, format } = require("winston");
const LokiTransport = require("winston-loki");
const githubAPIUrl = "https://api.github.com";
const { combine, timestamp, label, printf } = format;

/**
 *
 * @param {*} ghToken
 * @returns
 */
export function getClient(ghToken) {
  return new HttpClient("gh-http-client", [], {
    headers: {
      Authorization: `token ${ghToken}`,
      "Content-Type": "application/json",
    },
  });
}

/**
 *
 * @param {*} httpClient
 * @param {*} repo
 * @param {*} runId
 * @param {*} allowList
 * @returns
 */
export async function fetchJobs(httpClient, repo, runId, allowList) {
  const url = `${githubAPIUrl}/repos/${repo}/actions/runs/${runId}/jobs`;
  const res = await httpClient.get(url);

  if (res.message.statusCode === undefined || res.message.statusCode >= 400) {
    throw new Error(`HTTP request failed: ${res.message.statusMessage}`);
  }

  const body = await res.readBody();
  const jobs = [];
  const all = allowList.length === 0;
  for (const j of JSON.parse(body).jobs) {
    // if there's an allow list, skip job accordingly
    if (!all && !allowList.includes(j.name)) {
      continue;
    }

    jobs.push({
      id: j.id,
      name: j.name,
    });
  }

  return jobs;
}

/**
 *
 * @param {*} httpClient
 * @param {*} repo
 * @param {*} job
 * @returns
 */

export async function fetchLogs(httpClient, repo, job) {
  const url = `${githubAPIUrl}/repos/${repo}/actions/jobs/${job.id}/logs`;
  const res = await httpClient.get(url);

  if (res.message.statusCode === undefined || res.message.statusCode >= 400) {
    throw new Error(`HTTP request failed: ${res.message.statusMessage}`);
  }

  const body = await res.readBody();
  return body.split("\n");
}

/**
 *
 * @param {*} value
 * @returns
 */
export function getCommaSeparatedInput(value) {
  let val = [];
  if (value !== "") {
    val = value.split(",");
    val = val.map((s) => s.trim());
  }

  return val;
}

export async function run() {
  try {
    // retrieve config params

    // Github repo token
    const repoToken = core.getInput("repo-token", { required: true });
    // List of jobs to collect logs from (all jobs when empty)
    const jobNames = core.getInput("job-names", { required: false });
    const allowList = getCommaSeparatedInput(jobNames);
    // LogQL Push endpoint
    const endpoint = core.getInput("endpoint", { required: false });
    // LogQL endpoints (when endpoint is not present)
    const addrValue = core.getInput("addresses", { required: false });
    const addresses = getCommaSeparatedInput(addrValue);
    // LogQL partition ID
    const partitionId = core.getInput("partition", { required: false });
    // logql user
    const username = core.getInput("username", { required: false });
    // logql pass
    const password = core.getInput("password", { required: false });

    // Ensure either endpoint or addresses are set
    if (endpoint === "" && addresses.length === 0) {
      throw new Error(
        "invalid configuration: please set either endpoint or addresses"
      );
    }

    // get an authenticated HTTP client for the GitHub API
    const client = getClient(repoToken);

    // get all the jobs for the current workflow
    const workflowId = process.env["GITHUB_RUN_ID"] || "";
    const repo = process.env["GITHUB_REPOSITORY"] || "";
    core.debug(`Allow listing ${allowList.length} jobs in repo ${repo}`);
    const jobs = await fetchJobs(client, repo, workflowId, allowList);

    const onConnectionError = (err) => {
      core.debug("Error at connecting with logs endpoint\n", err);
    };
    const lokiBasicAuth = () => {
      if (username && password) {
        return `${username}:${password}`;
      }
      return "";
    };

    const lokiFormat = printf(({ level, message, label, timestamp }) => {
      return `${timestamp} [${label}] ${level}: ${message}`;
    });

    const options = (job) => {
      return {
        format: combine(label({ type: "github" }), timestamp(), lokiFormat),
        transports: [
          new LokiTransport({
            labels: {
              job: job?.name,
              repo,
              workflowId,
              type: "github",
            },
            host: endpoint || addresses[0],
            json: true,
            batching: false,
            gracefulShutdown: true,
            timeout: 0,
            onConnectionError: onConnectionError,
            lokiBasicAuth: lokiBasicAuth(),
          }),
        ],
      };
    };
    const logger = (job) => createLogger(options(job));

    // get the logs for each job
    core.debug(`Getting logs for ${jobs.length} jobs`);
    for (const j of jobs) {
      const logs = logger(j);
      const lines = await fetchLogs(client, repo, j);
      core.debug(`Fetched ${lines.length} lines for job ${j.name}`);
      const gh_log_regex =
        /^\s?(?<timestamp>((19|20)[0-9][0-9])[-](0[1-9]|1[012])[-](0[1-9]|[12][0-9]|3[01])[T]([01][1-9]|[2][0-3])[:]([0-5][0-9])[:]([0-5][0-9])[.](?<nanosec>[0-9][0-9][0-9][0-9][0-9][0-9][0-9])[Z])\s(?<log>.*){0,1}/;
      // const regex = /(?<timestamp>.*?)\s(?<logline>.*)$/;
      // const regnano = /\.(?<nanosec>.*)Z$/;

      for (const l of lines) {
        try {
          const line = l.match(gh_log_regex);
          core.debug(JSON.stringify(line.groups));
          if (!line?.groups?.timestamp && !line?.groups?.log) {
            core.error("no lines match");
            return;
            //  core.debug("no lines match");
          } else {
            const { timestamp, log, nanosec } = line?.groups;
            const nano = parseInt(nanosec) || "000000";
            //parseInt(timestamp.match(regnano).groups.nanosec) || "000000";
            const seconds = parseInt(new Date(timestamp).getTime() / 1000);
            const s = parseInt(seconds + nano.toString());
            const xlog = `{timestamp:${s},message:${JSON.stringify(log)}}`;
            core.debug(xlog);
            logs.info(xlog);
          }
        } catch (e) {
          const xlog = `{timestamp:${Date.now()},message:${JSON.stringify(l)}}`;
          logs.info(`${xlog}`);
          core.warning(`parser error: ${e}`);
        }
      }
      logs.clear();
    }
  } catch (e) {
    core.debug(`Error at process: ${e}`);
    core.setFailed(`Run failed: ${e}`);
  }
}

await run();
