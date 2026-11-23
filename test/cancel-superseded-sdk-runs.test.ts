import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cancelSupersededSdkRuns,
  type ActionsApi,
} from "../scripts/ci/cancel-superseded-sdk-runs.ts";

const oldSha = "a".repeat(40);
const currentSha = "b".repeat(40);
const pr = {
  number: 12,
  state: "open",
  base: { ref: "main", repo: { id: 1 } },
  head: { ref: "topic", sha: currentSha, repo: { id: 1 } },
};

function run(id: number, runNumber: number, sha: string, status = "queued") {
  return {
    id,
    workflow_id: 42,
    path: ".github/workflows/node-client.yml",
    event: "pull_request",
    status,
    run_number: runNumber,
    run_attempt: 1,
    repository: { id: 1 },
    head_repository: { id: 1 },
    head_sha: sha,
    head_branch: pr.head.ref,
    pull_requests: [{ ...pr, head: { ...pr.head, sha } }],
  };
}

const trigger = run(200, 21, currentSha, "requested");
const event = { action: "requested", repository: { id: 1 }, workflow_run: trigger };

function github(
  runs: ReturnType<typeof run>[],
  overrides: {
    readPull?: () => typeof pr;
    readRun?: (id: number) => ReturnType<typeof run> | undefined;
    cancel?: (id: number) => boolean;
  } = {},
) {
  const cancellations: number[] = [];
  const api: ActionsApi = {
    async get<T>(path: string) {
      if (path === "pulls/12") return (overrides.readPull?.() ?? pr) as T;
      if (path.startsWith("actions/workflows/42/runs?")) {
        const query = new URLSearchParams(path.split("?")[1]);
        assert.equal(query.get("event"), "pull_request");
        assert.equal(query.get("branch"), "topic");
        return { workflow_runs: runs.filter((entry) => entry.status === query.get("status")) } as T;
      }
      const id = Number(path.split("/").at(-1));
      const found = overrides.readRun?.(id) ?? [trigger, ...runs].find((entry) => entry.id === id);
      assert.ok(found, `unexpected lookup for ${path}`);
      return found as T;
    },
    async cancel(id) {
      cancellations.push(id);
      return overrides.cancel?.(id) ?? true;
    },
  };
  return { api, cancellations };
}

test("cancels only earlier queued or running runs for the same SDK and PR", async () => {
  const otherPR = {
    ...run(93, 3, oldSha),
    pull_requests: [{ ...run(93, 3, oldSha).pull_requests[0]!, number: 13 }],
  };
  const otherWorkflow = {
    ...run(94, 4, oldSha),
    workflow_id: 43,
    path: ".github/workflows/rust.yml",
  };
  const { api, cancellations } = github([
    run(100, 18, oldSha),
    run(101, 19, oldSha, "in_progress"),
    run(102, 20, currentSha),
    trigger,
    run(201, 22, oldSha),
    run(98, 15, oldSha, "completed"),
    otherPR,
    otherWorkflow,
    { ...run(95, 5, oldSha), event: "push" },
    { ...run(96, 6, oldSha), event: "workflow_dispatch" },
    { ...run(97, 7, oldSha), repository: { id: 9 } },
    { ...run(99, 16, oldSha), pull_requests: [] },
    { ...run(103, 17, oldSha), pull_requests: [otherPR.pull_requests[0]!, pr] },
  ]);
  assert.deepEqual(await cancelSupersededSdkRuns(event, api), [100, 101]);
  assert.deepEqual(cancellations, [100, 101]);
});

test("uses the run SHA when the linked PR already reports the replacement SHA", async () => {
  const old = { ...run(100, 18, oldSha), pull_requests: [pr] };
  const { api, cancellations } = github([old]);
  assert.deepEqual(await cancelSupersededSdkRuns(event, api), [100]);
  assert.deepEqual(cancellations, [100]);
});

test("rejects reruns, main events, an outdated request, and ambiguous PR identities", async () => {
  for (const workflow_run of [
    { ...trigger, run_attempt: 2 },
    { ...trigger, event: "push" },
  ]) {
    const { api, cancellations } = github([run(100, 18, oldSha)]);
    assert.deepEqual(await cancelSupersededSdkRuns({ ...event, workflow_run }, api), []);
    assert.deepEqual(cancellations, []);
  }
  const stale = github([run(100, 18, oldSha)], {
    readPull: () => ({ ...pr, head: { ...pr.head, sha: oldSha } }),
  });
  assert.deepEqual(await cancelSupersededSdkRuns(event, stale.api), []);
  assert.deepEqual(stale.cancellations, []);
});

test("reads stored PR metadata and retries on the first start event", async () => {
  const old = run(100, 18, oldSha);
  const startEvent = { ...event, action: "in_progress" };
  const missing = github([old], {
    readRun: (id) => (id === trigger.id ? { ...trigger, pull_requests: [] } : undefined),
  });
  assert.deepEqual(await cancelSupersededSdkRuns(event, missing.api), []);
  assert.deepEqual(missing.cancellations, []);

  const started = github([old]);
  const snapshot = { ...startEvent, workflow_run: { ...trigger, pull_requests: [] } };
  assert.deepEqual(await cancelSupersededSdkRuns(snapshot, started.api), [100]);
  const rerun = { ...startEvent, workflow_run: { ...trigger, run_attempt: 2 } };
  assert.deepEqual(await cancelSupersededSdkRuns(rerun, started.api), []);
  assert.deepEqual(started.cancellations, [100]);
});

test("rechecks the live PR immediately before each cancellation", async () => {
  let reads = 0;
  const { api, cancellations } = github([run(100, 18, oldSha), run(101, 19, oldSha)], {
    readPull() {
      return ++reads < 3 ? pr : { ...pr, head: { ...pr.head, sha: oldSha } };
    },
  });
  assert.deepEqual(await cancelSupersededSdkRuns(event, api), [100]);
  assert.deepEqual(cancellations, [100]);
});

test("keeps a run that completed and ignores a conflicting cancellation", async () => {
  const { api, cancellations } = github([run(100, 18, oldSha), run(101, 19, oldSha)], {
    readRun: (id) => (id === 100 ? run(100, 18, oldSha, "completed") : undefined),
    cancel: () => false,
  });
  assert.deepEqual(await cancelSupersededSdkRuns(event, api), []);
  assert.deepEqual(cancellations, [101]);
});

test("keeps all older runs if the replacement stopped before cancellation", async () => {
  let reads = 0;
  const { api, cancellations } = github([run(100, 18, oldSha)], {
    readRun: (id) =>
      id === trigger.id && ++reads > 1 ? { ...trigger, status: "completed" } : undefined,
  });
  assert.deepEqual(await cancelSupersededSdkRuns(event, api), []);
  assert.deepEqual(cancellations, []);
});
