import { readFile } from "node:fs/promises";

const sdkWorkflows = new Set([".github/workflows/node-client.yml", ".github/workflows/rust.yml"]);
const activeStatuses = ["requested", "waiting", "pending", "queued", "in_progress"];

interface Ref {
  ref: string;
  repo: { id: number } | null;
}

interface PullRequest {
  number: number;
  base: Ref;
  head: Ref & { sha: string };
  state?: string;
}

interface Run {
  id: number;
  workflow_id: number;
  path: string;
  event: string;
  status: string;
  run_number: number;
  run_attempt: number;
  repository: { id: number };
  head_repository: { id: number } | null;
  head_sha: string;
  head_branch: string;
  pull_requests: PullRequest[];
}

interface RequestedEvent {
  action: string;
  repository: { id: number };
  workflow_run: Run;
}

export interface ActionsApi {
  get<T>(path: string): Promise<T>;
  cancel(id: number): Promise<boolean>;
}

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function association(run: Run, repositoryId: number): PullRequest | undefined {
  if (
    run.event !== "pull_request" ||
    !sdkWorkflows.has(run.path) ||
    run.repository?.id !== repositoryId ||
    !positiveInteger(run.id) ||
    !positiveInteger(run.workflow_id) ||
    !positiveInteger(run.run_number) ||
    !/^[0-9a-f]{40}$/.test(run.head_sha) ||
    !activeStatuses.includes(run.status) ||
    run.pull_requests?.length !== 1
  )
    return;

  const pull = run.pull_requests[0]!;
  const headRepositoryId = run.head_repository?.id;
  if (
    positiveInteger(pull.number) &&
    pull.base?.repo?.id === repositoryId &&
    !!pull.base.ref &&
    headRepositoryId !== undefined &&
    positiveInteger(headRepositoryId) &&
    pull.head?.repo?.id === headRepositoryId &&
    !!pull.head.ref &&
    pull.head.ref === run.head_branch &&
    pull.head.sha === run.head_sha
  )
    return pull;
}

function samePull(left: PullRequest, right: PullRequest): boolean {
  return (
    left.number === right.number &&
    left.base?.repo?.id === right.base.repo?.id &&
    left.base?.ref === right.base.ref &&
    left.head?.repo?.id === right.head.repo?.id &&
    left.head?.ref === right.head.ref
  );
}

export async function cancelSupersededSdkRuns(
  event: RequestedEvent,
  api: ActionsApi,
): Promise<number[]> {
  const trigger = event.workflow_run;
  const repositoryId = event.repository?.id;
  if (
    event.action !== "requested" ||
    !positiveInteger(repositoryId) ||
    !trigger ||
    trigger.run_attempt !== 1
  )
    return [];

  const pull = association(trigger, repositoryId);
  if (!pull) return [];

  const scope = { repositoryId, pull };
  const runPath = (id: number) => `actions/runs/${id}`;
  const pullPath = `pulls/${pull.number}`;

  async function replacementIsCurrent(): Promise<boolean> {
    const replacement = await api.get<Run>(runPath(trigger.id));
    const link = association(replacement, scope.repositoryId);
    if (
      !link ||
      !samePull(link, scope.pull) ||
      replacement.id !== trigger.id ||
      replacement.workflow_id !== trigger.workflow_id ||
      replacement.path !== trigger.path ||
      replacement.run_number !== trigger.run_number ||
      replacement.run_attempt !== 1 ||
      replacement.head_sha !== trigger.head_sha
    )
      return false;

    // Read the live head last so a delayed event never uses an old PR snapshot.
    const live = await api.get<PullRequest>(pullPath);
    return (
      live.state === "open" && samePull(live, scope.pull) && live.head.sha === trigger.head_sha
    );
  }

  function isObsolete(candidate: Run): boolean {
    const link = association(candidate, scope.repositoryId);
    return (
      !!link &&
      samePull(link, scope.pull) &&
      candidate.workflow_id === trigger.workflow_id &&
      candidate.path === trigger.path &&
      candidate.id !== trigger.id &&
      // GitHub increments run_number for each new run of this workflow. A
      // restart keeps its original number, so the replacement and any
      // later runs are outside this event's cancellation authority.
      candidate.run_number < trigger.run_number &&
      candidate.head_sha !== trigger.head_sha
    );
  }

  if (!(await replacementIsCurrent())) return [];
  const ids = new Set<number>();
  for (const status of activeStatuses) {
    for (let page = 1; page <= 10; page++) {
      const params = new URLSearchParams({
        event: "pull_request",
        branch: trigger.head_branch,
        status,
        per_page: "100",
        page: String(page),
      });
      const { workflow_runs: runs } = await api.get<{ workflow_runs: Run[] }>(
        `actions/workflows/${trigger.workflow_id}/runs?${params}`,
      );
      for (const run of runs) if (isObsolete(run)) ids.add(run.id);
      if (runs.length < 100) break;
    }
  }

  const cancelled: number[] = [];
  for (const id of ids) {
    const candidate = await api.get<Run>(runPath(id));
    if (candidate.id !== id || !isObsolete(candidate)) continue;
    if (!(await replacementIsCurrent())) break;
    if (await api.cancel(id)) cancelled.push(id);
  }
  return cancelled;
}

async function main(): Promise<void> {
  const { GITHUB_API_URL, GITHUB_EVENT_PATH, GITHUB_REPOSITORY, GITHUB_TOKEN } = process.env;
  if (
    !GITHUB_API_URL ||
    !GITHUB_EVENT_PATH ||
    !GITHUB_REPOSITORY ||
    !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(GITHUB_REPOSITORY) ||
    !GITHUB_TOKEN
  )
    throw new Error("Missing GitHub Actions environment");

  const base = `${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}/`;
  async function request(path: string, method: string): Promise<Response> {
    return fetch(base + path, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${GITHUB_TOKEN}`,
      },
    });
  }
  const event = JSON.parse(await readFile(GITHUB_EVENT_PATH, "utf8")) as RequestedEvent;
  const cancelled = await cancelSupersededSdkRuns(event, {
    async get<T>(path: string): Promise<T> {
      const response = await request(path, "GET");
      if (!response.ok) throw new Error(`GitHub lookup failed with HTTP ${response.status}`);
      return (await response.json()) as T;
    },
    async cancel(id: number): Promise<boolean> {
      const response = await request(`actions/runs/${id}/cancel`, "POST");
      if (response.status === 409) return false; // The run already finished.
      if (response.status !== 202)
        throw new Error(`Could not cancel run ${id} (HTTP ${response.status})`);
      console.log(`Requested cancellation of superseded run ${id}.`);
      return true;
    },
  });
  if (!cancelled.length) console.log("No superseded SDK runs matched this request.");
}

if (import.meta.main) await main();
