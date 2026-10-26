use super::{Action, Client, Error, Kind, Policy, Request, RunResult, Store, now_ms, wire};
use serde::{Deserialize, Serialize};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Reserved host entry point, handled before parsing normal commands.
pub const BACKGROUND_WORKER_ARGUMENT: &str = "--app-tracking-worker-v1";
const JOB_LIFETIME_MS: u64 = 30_000;
const REQUEST_BUDGET: Duration = Duration::from_secs(5);

/// Local versioned handoff metadata only. Payload and credential stay in the
/// existing private state; the process argument carries only a random job nonce.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Job {
    schema_version: u8,
    nonce: String,
    generation: u64,
    attempt: u64,
    kind: Kind,
    batch_id: Option<String>,
    created_ms: u64,
}

pub(super) fn start(
    client: &Client,
    policy: &Policy,
    request: &Request,
    now: u64,
) -> Result<(), Error> {
    let nonce = wire::token()?;
    {
        let store = Store::claim(&client.directory(policy), false)?.ok_or(Error::State)?;
        let _network = store.network_guard()?.ok_or(Error::Busy)?;
        let state = client.load(&store, policy)?;
        if state.generation != request.generation || state.attempt != request.attempt {
            return Err(Error::Busy);
        }
        store.write_worker(&Job {
            schema_version: 1,
            nonce: nonce.clone(),
            generation: request.generation,
            attempt: request.attempt,
            kind: request.kind,
            batch_id: request.batch.as_ref().map(|batch| batch.id.clone()),
            created_ms: now,
        })?;
    }
    let mut command = Command::new(std::env::current_exe().map_err(|_| Error::Background)?);
    command
        .arg(BACKGROUND_WORKER_ARGUMENT)
        .arg(nonce)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP. No console or inherited
        // foreground Ctrl+C group; no attempt to escape a CI/container job.
        command.creation_flags(0x0000_0008 | 0x0000_0200);
    }
    let mut child = command.spawn().map_err(|_| Error::Background)?;
    // Reap while a long-lived host remains alive, without joining this thread.
    // If the host exits first, normal OS process reparenting owns cleanup.
    let _ = std::thread::Builder::new()
        .name("app-tracking-reaper".into())
        .spawn(move || {
            let _ = child.wait();
        });
    Ok(())
}

fn suppressed() -> RunResult {
    RunResult {
        counted: false,
        action: Action::Suppressed,
    }
}

// Brief counter/status writes must not make a launched worker miss its only
// operation. Only the worker waits; foreground callers still use try_lock.
fn claim_store(client: &Client, policy: &Policy) -> Result<Option<Store>, Error> {
    let deadline = Instant::now() + Duration::from_millis(100);
    loop {
        match Store::claim(&client.directory(policy), false) {
            Err(Error::Busy) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(5))
            }
            result => return result,
        }
    }
}

pub(super) fn run(client: &Client, policy: &Policy, nonce: &str) -> Result<RunResult, Error> {
    if nonce.len() != 64
        || !nonce
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err(Error::Configuration);
    }
    let now = now_ms()?;
    let Some(store) = claim_store(client, policy)? else {
        return Ok(suppressed());
    };
    let Some(network) = store.network_guard()? else {
        return Ok(suppressed());
    };
    let Some(job) = store.read_worker()? else {
        return Ok(suppressed());
    };
    if job.nonce != nonce {
        return Ok(suppressed());
    }
    // Consume before I/O. A stale/duplicate child cannot execute this operation
    // again; a crash retains the immutable report in state for the next retry.
    store.consume_worker()?;
    let mut state = client.load(&store, policy)?;
    let effective = client.reconcile(&mut state, policy, now)?;
    store.save(&mut state)?;
    if job.schema_version != 1
        || job.created_ms > now
        || now - job.created_ms > JOB_LIFETIME_MS
        || state.generation != job.generation
        || state.attempt != job.attempt
        || state.terminal_status.is_some()
    {
        return Ok(suppressed());
    }
    let Some(authority) = &state.authority else {
        return Ok(suppressed());
    };
    let batch = match job.kind {
        Kind::Register
            if effective.upload && !authority.registered && !authority.declaration.is_empty() =>
        {
            None
        }
        Kind::Upload if effective.upload && authority.registered => {
            let Some(batch) = state
                .batches
                .first()
                .filter(|batch| Some(&batch.id) == job.batch_id.as_ref())
            else {
                return Ok(suppressed());
            };
            Some(batch.clone())
        }
        Kind::Delete if effective.delete => None,
        _ => return Ok(suppressed()),
    };
    let request = Request {
        generation: job.generation,
        attempt: job.attempt,
        kind: job.kind,
        id: authority.id.clone(),
        token: authority.token.clone(),
        body: match job.kind {
            Kind::Register => authority.declaration.clone(),
            Kind::Upload => batch.as_ref().ok_or(Error::State)?.body.clone(),
            Kind::Delete => String::new(),
        },
        batch,
    };
    drop(store);
    let response =
        wire::send_with_budget(&client.origin, &client.tool, &request, now, REQUEST_BUDGET);
    drop(network);
    let store = claim_store(client, policy)?.ok_or(Error::State)?;
    let action = client.acknowledge_locked(&store, policy, &request, response, now)?;
    Ok(RunResult {
        counted: false,
        action,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::{Origin, RepositoryContext};
    use crate::telemetry::{Control, Invocation};

    fn prepared() -> (tempfile::TempDir, Client, Policy, String) {
        let root = tempfile::tempdir().unwrap();
        let client = Client::new("https://example.invalid", root.path(), "palamedes").unwrap();
        let policy = Policy::default();
        client.control(Control::Enable, &policy).unwrap();
        let nonce = "1".repeat(64);
        client
            .run_attempt_at(
                &policy,
                Some(Invocation {
                    command: "report",
                    tool_version: "2.0.0",
                }),
                || RepositoryContext {
                    origin: Origin::Unavailable,
                    package_json: None,
                },
                false,
                now_ms().unwrap(),
                true,
                |request, now| {
                    let store =
                        Store::claim(&client.directory(&policy), false)?.ok_or(Error::State)?;
                    store.write_worker(&Job {
                        schema_version: 1,
                        nonce: nonce.clone(),
                        generation: request.generation,
                        attempt: request.attempt,
                        kind: request.kind,
                        batch_id: None,
                        created_ms: now,
                    })?;
                    Ok(None)
                },
            )
            .unwrap();
        (root, client, policy, nonce)
    }

    #[test]
    fn withdrawal_before_worker_start_removes_the_handoff_and_counters() {
        let (_root, client, policy, nonce) = prepared();
        client.control(Control::Withdraw, &policy).unwrap();
        assert_eq!(
            client
                .run_background_worker(&policy, &nonce)
                .unwrap()
                .action,
            Action::Suppressed
        );
        assert_eq!(client.status(&policy).unwrap().unsent_invocations, 0);
    }

    #[test]
    fn worker_rechecks_offline_and_veto_and_never_counts_itself() {
        for veto in [false, true] {
            let (_root, client, mut policy, nonce) = prepared();
            policy.offline = !veto;
            policy.do_not_track = veto;
            assert_eq!(
                client
                    .run_background_worker(&policy, &nonce)
                    .unwrap()
                    .action,
                Action::Suppressed
            );
            assert_eq!(
                client.status(&policy).unwrap().unsent_invocations,
                u64::from(!veto)
            );
        }
    }

    #[test]
    fn old_generation_and_expired_handoffs_cannot_start_requests() {
        for expired in [false, true] {
            let (_root, client, policy, nonce) = prepared();
            {
                let store = Store::claim(&client.directory(&policy), false)
                    .unwrap()
                    .unwrap();
                let mut job = store.read_worker().unwrap().unwrap();
                if expired {
                    job.created_ms -= JOB_LIFETIME_MS + 1;
                } else {
                    job.generation += 1;
                }
                store.write_worker(&job).unwrap();
            }
            assert_eq!(
                client
                    .run_background_worker(&policy, &nonce)
                    .unwrap()
                    .action,
                Action::Suppressed
            );
            let store = Store::claim(&client.directory(&policy), false)
                .unwrap()
                .unwrap();
            assert!(store.read_worker().unwrap().is_none());
            assert_eq!(client.load(&store, &policy).unwrap().open.len(), 1);
        }
    }
}
