//! Explicit opt-in usage reporting, separate from update checks.
//!
//! Hosts present the disclosure, resolve policy, and designate exactly one CLI
//! invocation owner. Construction/import performs no I/O or collection. Call
//! [`Client::run`] after command work; preserve stdout and the command's status.
//! Each call makes at most one synchronous request with a 200 ms network budget.
//! See the repository's `docs/rust-telemetry-client.md` for lifecycle and storage.

mod policy;
mod state;
mod store;
mod wire;

pub use policy::{CONSENT_REVISION, Decision, EffectivePolicy, GrantSource, Policy};
use serde::{Deserialize, Serialize};
use state::{Authority, Grant, State};
use std::path::PathBuf;
use store::Store;
use wire::{Kind, Request, Response};

/// Advisory errors with no input, token, URL, payload, or path in diagnostics.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum Error {
    #[error("invalid telemetry configuration or invocation")]
    Configuration,
    #[error("private telemetry state unavailable or invalid")]
    State,
    #[error("telemetry state is busy")]
    Busy,
    #[error("telemetry clock outside supported range")]
    Clock,
    #[error("secure telemetry randomness unavailable")]
    Randomness,
    #[error("resolve the previous identity before a new consent grant")]
    PreviousIdentity,
}

/// Host controls. Enable requires an affirmative informed human decision after
/// disclosure. Reset/renew delete the old identity first, then require Enable;
/// neither retry nor import manufactures a fresh grant.
#[derive(Debug, Clone, Copy)]
pub enum Control {
    Enable,
    Decline,
    Withdraw,
    Delete,
    Reset,
    /// Explicitly acknowledge that remote deletion was not verified. This drops
    /// local authority; a later Enable is a separate affirmative decision.
    ForgetUnverified,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum DeletionStatus {
    #[default]
    None,
    Pending,
    Confirmed,
    NoActiveRecord,
    NoRemoteIdentity,
    Unverified,
}

/// Fixed outcome vocabulary. Ordinary commands should not print these outcomes.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Idle,
    Suppressed,
    Registered,
    Accepted,
    DeletionComplete,
    RetryScheduled,
    Paused,
}

#[derive(Debug, Clone, Serialize)]
pub struct RunResult {
    pub counted: bool,
    pub action: Action,
}

/// Only host-authored command category and exact installed SemVer are accepted.
/// Unknown categories collapse to `other`; excluded commands should pass None
/// to run. Never supply arguments, skill names, arbitrary errors, or paths.
pub struct Invocation<'a> {
    pub command: &'a str,
    pub tool_version: &'a str,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Row {
    day: String,
    tool_version: String,
    command: String,
    count: u32,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    project_id: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    project_id_version: Option<u8>,
}

fn present<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(deserializer).map(Some)
}

impl Row {
    fn dimension(&self) -> Result<String, Error> {
        let mut value = serde_json::to_value(self).map_err(|_| Error::State)?;
        value.as_object_mut().ok_or(Error::State)?.remove("count");
        wire::canonical(value)
    }
}

/// Local inspection only. No credential or raw repository metadata is exposed.
#[derive(Debug, Serialize)]
pub struct Status {
    pub decision: Decision,
    pub effective: EffectivePolicy,
    pub grant_source: Option<GrantSource>,
    pub consent_revision: Option<String>,
    pub consented_at: Option<String>,
    pub mode: String,
    pub installation_id: Option<String>,
    pub deletion: DeletionStatus,
    pub open_dimensions: usize,
    pub queued_batches: usize,
    pub unsent_invocations: u64,
    pub dropped_invocations: u64,
    pub next_attempt_ms: u64,
    pub terminal_status: Option<u16>,
}

/// One fixed service/tool with separate local/CI state. The host supplies a
/// private profile directory (or isolated per-run CI root). No I/O on creation.
pub struct Client {
    origin: String,
    root: PathBuf,
    tool: String,
}

impl std::fmt::Debug for Client {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("TelemetryClient([redacted configuration])")
    }
}

fn now_ms() -> Result<u64, Error> {
    let duration = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| Error::Clock)?;
    u64::try_from(duration.as_millis()).map_err(|_| Error::Clock)
}

fn version_valid(text: &str) -> bool {
    text.is_ascii()
        && text.len() <= 128
        && semver::Version::parse(text).is_ok()
        && text
            .split(['.', '-', '+'])
            .take(3)
            .all(|part| part.len() <= 10)
}

impl Client {
    /// HTTPS origin without credentials, path, query, or fragment. Numeric
    /// loopback HTTP is accepted solely for synthetic integration tests.
    /// Initial telemetry catalog supports `dalo`; update tools are independent.
    pub fn new(origin: &str, state_root: impl Into<PathBuf>, tool: &str) -> Result<Self, Error> {
        let uri: ureq::http::Uri = origin.parse().map_err(|_| Error::Configuration)?;
        let loopback = uri
            .host()
            .unwrap_or("")
            .trim_start_matches('[')
            .trim_end_matches(']')
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback());
        if !(uri.scheme_str() == Some("https") || (uri.scheme_str() == Some("http") && loopback))
            || uri.authority().is_none_or(|a| a.as_str().contains('@'))
            || uri.query().is_some()
            || uri.path() != "/"
            || origin.contains('#')
            || !policy::limits().tools.contains_key(tool)
        {
            return Err(Error::Configuration);
        }
        Ok(Self {
            origin: origin.trim_end_matches('/').into(),
            root: state_root.into(),
            tool: tool.into(),
        })
    }

    fn directory(&self, policy: &Policy) -> PathBuf {
        self.root
            .join(wire::sha256(self.origin.as_bytes()))
            .join(&self.tool)
            .join(policy.mode())
    }

    fn scope(&self, policy: &Policy) -> String {
        format!("{}\n{}\n{}", self.origin, self.tool, policy.mode())
    }

    fn load(&self, store: &Store, policy: &Policy) -> Result<State, Error> {
        let state = store.load(&self.scope(policy))?;
        state.validate(&self.tool, policy.mode())?;
        Ok(state)
    }

    /// Persist a semantic control locally. No network request is made here.
    /// Follow Delete/Reset with run(None, ...) to attempt at most one deletion;
    /// subsequent ordinary invocations can retry pending deletion when online.
    pub fn control(&self, control: Control, policy: &Policy) -> Result<Status, Error> {
        self.control_at(control, policy, now_ms()?)
    }

    fn control_at(&self, control: Control, policy: &Policy, now: u64) -> Result<Status, Error> {
        let store = Store::claim(&self.directory(policy), true)?.ok_or(Error::State)?;
        // A successful withdrawal must not race a request starting afterward.
        // Controls return Busy while a bounded request owns this separate lock;
        // ordinary counter writes continue using only the short state lock.
        let _network = store.network_guard()?.ok_or(Error::Busy)?;
        let mut state = self.load(&store, policy)?;
        state.prune(now)?;
        match control {
            Control::Enable => {
                if state.decision == Decision::Enabled
                    && state.grant.as_ref().is_some_and(|g| {
                        g.revision == CONSENT_REVISION && g.source == GrantSource::Explicit
                    })
                {
                    return self.status_of(&state, policy);
                }
                if state.authority.is_some() || state.deletion == DeletionStatus::Pending {
                    return Err(Error::PreviousIdentity);
                }
                state.clear_usage();
                state.generation = state.generation.saturating_add(1);
                state.decision = Decision::Enabled;
                state.grant = Some(Grant {
                    revision: CONSENT_REVISION.into(),
                    source: GrantSource::Explicit,
                    at_ms: now,
                });
                state.last_invocation_ms = now;
                state.terminal_status = None;
                state.withdrawn_ms = None;
                state.next_attempt_ms = 0;
                state.failures = 0;
            }
            Control::Decline => state.withdraw(Decision::Declined, now),
            Control::Withdraw => state.withdraw(Decision::Withdrawn, now),
            Control::Delete | Control::Reset => {
                if state.deletion != DeletionStatus::Pending {
                    state.withdraw(Decision::Withdrawn, now);
                    state.deletion = if state.authority.is_some() {
                        DeletionStatus::Pending
                    } else if state.deletion != DeletionStatus::None {
                        state.deletion
                    } else {
                        DeletionStatus::NoRemoteIdentity
                    };
                    state.next_attempt_ms = 0;
                    state.failures = 0;
                    // Deletion needs no declaration, consent metadata, or prior usage.
                    if let Some(a) = &mut state.authority {
                        a.declaration.clear();
                    }
                }
            }
            Control::ForgetUnverified => {
                state.withdraw(Decision::Withdrawn, now);
                state.authority = None;
                state.deletion = DeletionStatus::Unverified;
            }
        }
        store.save(&mut state)?;
        self.status_of(&state, policy)
    }

    fn status_of(&self, state: &State, policy: &Policy) -> Result<Status, Error> {
        Ok(Status {
            decision: state.decision,
            effective: policy::effective(state, policy),
            grant_source: state.grant.as_ref().map(|g| g.source),
            consent_revision: state.grant.as_ref().map(|g| g.revision.clone()),
            consented_at: state
                .grant
                .as_ref()
                .map(|g| wire::timestamp(g.at_ms))
                .transpose()?,
            mode: policy.mode().into(),
            installation_id: state.authority.as_ref().map(|a| a.id.clone()),
            deletion: state.deletion,
            open_dimensions: state.open.len(),
            queued_batches: state.batches.len(),
            unsent_invocations: state.open.values().map(|r| u64::from(r.count)).sum::<u64>()
                + state.batches.iter().map(|b| b.count).sum::<u64>(),
            dropped_invocations: state.dropped_invocations,
            next_attempt_ms: state.next_attempt_ms,
            terminal_status: state.terminal_status,
        })
    }

    fn reconcile(
        &self,
        state: &mut State,
        policy: &Policy,
        now: u64,
    ) -> Result<EffectivePolicy, Error> {
        state.prune(now)?;
        let effective = policy::effective(state, policy);
        if !effective.collect
            && (policy.veto()
                || !policy.context_allowed()
                || effective.reason == "environment_grant_absent")
        {
            if !state.open.is_empty() || !state.batches.is_empty() {
                state.generation = state.generation.saturating_add(1);
            }
            state.clear_usage();
        }
        Ok(effective)
    }

    fn inspect(&self, policy: &Policy) -> Result<State, Error> {
        let Some(store) = Store::claim(&self.directory(policy), false)? else {
            return Ok(State::new(&self.scope(policy)));
        };
        let mut state = self.load(&store, policy)?;
        self.reconcile(&mut state, policy, now_ms()?)?;
        store.save(&mut state)?;
        Ok(state)
    }

    /// Inspect effective settings and coverage, without a request or new state.
    /// Existing expired or vetoed usage is removed locally.
    pub fn status(&self, policy: &Policy) -> Result<Status, Error> {
        self.status_of(&self.inspect(policy)?, policy)
    }

    /// Exact immutable payloads plus open rows, with no credential or URL.
    /// Open rows are not yet a batch; preview never closes or re-IDs them.
    pub fn preview(&self, policy: &Policy) -> Result<String, Error> {
        let state = self.inspect(policy)?;
        let registration = state
            .authority
            .as_ref()
            .filter(|a| !a.declaration.is_empty())
            .map(|a| serde_json::from_str::<serde_json::Value>(&a.declaration))
            .transpose()
            .map_err(|_| Error::State)?;
        let batches = state
            .batches
            .iter()
            .map(|b| serde_json::from_str::<serde_json::Value>(&b.body))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| Error::State)?;
        wire::canonical(
            serde_json::json!({"status":self.status_of(&state, policy)?,"registration":registration,"batches":batches,"open_rows":state.open.values().collect::<Vec<_>>()}),
        )
    }

    /// Count at most one eligible invocation, then claim at most one due request.
    /// The project closure is never invoked before effective collection consent.
    /// `flush` closes current counts early but never bypasses retry suppression.
    /// No telemetry error should change the host command's output or exit code.
    pub fn run(
        &self,
        policy: &Policy,
        invocation: Option<Invocation<'_>>,
        project: impl FnOnce() -> crate::project::RepositoryContext,
        flush: bool,
    ) -> Result<RunResult, Error> {
        self.run_at(
            policy,
            invocation,
            project,
            flush,
            now_ms()?,
            |request, now| wire::send(&self.origin, request, now),
        )
    }

    fn run_at(
        &self,
        policy: &Policy,
        invocation: Option<Invocation<'_>>,
        project: impl FnOnce() -> crate::project::RepositoryContext,
        flush: bool,
        now: u64,
        transport: impl FnOnce(&Request, u64) -> Response,
    ) -> Result<RunResult, Error> {
        let create = !policy.veto() && policy.context_allowed() && policy.environment_grant();
        let Some(store) = Store::claim(&self.directory(policy), create)? else {
            return Ok(RunResult {
                counted: false,
                action: Action::Suppressed,
            });
        };
        let mut state = self.load(&store, policy)?;
        let effective = self.reconcile(&mut state, policy, now)?;
        if effective.collect {
            let today = wire::day(now)?;
            let future_grant = if let Some(grant) = &state.grant {
                grant.at_ms > now.saturating_add(300_000) || wire::day(grant.at_ms)? > today
            } else {
                false
            };
            if future_grant
                || state.open.values().any(|row| row.day > today)
                || state
                    .authority
                    .as_ref()
                    .and_then(|a| wire::birth(&a.id))
                    .is_some_and(|birth| birth > now.saturating_add(300_000))
                || state
                    .batches
                    .iter()
                    .any(|batch| batch.created_ms > now.saturating_add(300_000))
            {
                return Err(Error::Clock);
            }
        }
        if effective.collect && state.grant.is_none() {
            state.decision = Decision::Enabled;
            state.grant = Some(Grant {
                revision: CONSENT_REVISION.into(),
                source: GrantSource::Environment,
                at_ms: now,
            });
            state.last_invocation_ms = now;
        }
        let mut counted = false;
        if effective.collect
            && let Some(invocation) = invocation
        {
            if !version_valid(invocation.tool_version) {
                return Err(Error::Configuration);
            }
            let project = crate::project::identify(true, project);
            let commands = &policy::limits()
                .tools
                .get(&self.tool)
                .ok_or(Error::Configuration)?
                .commands;
            let command = if commands.iter().any(|c| c == invocation.command) {
                invocation.command
            } else {
                "other"
            };
            counted = state.count(
                Row {
                    day: wire::day(now)?,
                    tool_version: invocation.tool_version.into(),
                    command: command.into(),
                    count: 1,
                    project_id: project.as_ref().map(|p| p.hash().into()),
                    project_id_version: project.as_ref().map(|p| p.normalization_version()),
                },
                now,
            )?;
        }
        let due = (effective.upload || effective.delete)
            && state.terminal_status.is_none()
            && now >= state.next_attempt_ms;
        let network = if due { store.network_guard()? } else { None };
        let request = if network.is_some() {
            self.prepare(&mut state, policy, flush, now)?
        } else {
            None
        };
        store.save(&mut state)?;
        drop(store);
        let Some(request) = request else {
            return Ok(RunResult {
                counted,
                action: if effective.collect {
                    Action::Idle
                } else {
                    Action::Suppressed
                },
            });
        };
        let response = transport(&request, now);
        drop(network);
        let action = self.acknowledge(policy, &request, response, now)?;
        Ok(RunResult { counted, action })
    }

    fn acknowledge(
        &self,
        policy: &Policy,
        request: &Request,
        response: Response,
        now: u64,
    ) -> Result<Action, Error> {
        // Reacquire only to acknowledge this exact generation/attempt. New
        // counters stay intact, and withdrawal cannot be undone by a late ACK.
        let store = Store::claim(&self.directory(policy), false)?.ok_or(Error::State)?;
        let mut state = self.load(&store, policy)?;
        if state.generation != request.generation || state.attempt != request.attempt {
            return Ok(Action::Suppressed);
        }
        let action = self.finish(&mut state, request, response, now)?;
        store.save(&mut state)?;
        Ok(action)
    }

    fn prepare(
        &self,
        state: &mut State,
        policy: &Policy,
        flush: bool,
        now: u64,
    ) -> Result<Option<Request>, Error> {
        let effective = policy::effective(state, policy);
        if state.terminal_status.is_some()
            || now < state.next_attempt_ms
            || (!effective.upload && !effective.delete)
        {
            return Ok(None);
        }
        let kind = if effective.delete {
            Kind::Delete
        } else {
            if state.authority.is_none() {
                let grant = state.grant.as_ref().ok_or(Error::State)?;
                state.authority = Some(Authority {
                    id: wire::uuid7(now)?,
                    token: wire::token()?,
                    registered: false,
                    last_remote_ms: now,
                    declaration: wire::canonical(
                        serde_json::json!({"schema_version":1,"tool_id":self.tool,"consent_revision":grant.revision,"consented_at":wire::timestamp(grant.at_ms)?,"mode":policy.mode()}),
                    )?,
                });
            }
            if !state.authority.as_ref().ok_or(Error::State)?.registered {
                Kind::Register
            } else {
                if flush || state.next_close_ms.is_some_and(|due| now >= due) {
                    state.close(&self.tool, now)?;
                }
                if state.batches.is_empty() {
                    return Ok(None);
                }
                Kind::Upload
            }
        };
        let authority = state.authority.as_ref().ok_or(Error::State)?;
        let batch = if matches!(kind, Kind::Upload) {
            state.batches.first().cloned()
        } else {
            None
        };
        state.attempt = state.attempt.checked_add(1).ok_or(Error::State)?;
        state.failures = state
            .failures
            .saturating_add(1)
            .min(policy::limits().retry_seconds.len());
        state.next_attempt_ms =
            now.saturating_add(policy::limits().retry_seconds[state.failures - 1] * 1000);
        Ok(Some(Request {
            generation: state.generation,
            attempt: state.attempt,
            kind,
            id: authority.id.clone(),
            token: authority.token.clone(),
            body: if matches!(kind, Kind::Register) {
                authority.declaration.clone()
            } else {
                batch.as_ref().map(|b| b.body.clone()).unwrap_or_default()
            },
            batch,
        }))
    }

    fn finish(
        &self,
        state: &mut State,
        request: &Request,
        response: Response,
        now: u64,
    ) -> Result<Action, Error> {
        match response {
            Response::Retry(retry) => {
                if let Some(seconds) = retry {
                    state.next_attempt_ms = state
                        .next_attempt_ms
                        .max(now.saturating_add(seconds.clamp(60, 86_400) * 1000));
                }
                return Ok(Action::RetryScheduled);
            }
            Response::Terminal(status) => {
                if status == 410 {
                    state.withdraw(Decision::Expired, now);
                }
                state.terminal_status = Some(status);
                return Ok(Action::Paused);
            }
            Response::Registered => {
                state.authority.as_mut().ok_or(Error::State)?.registered = true;
            }
            Response::Accepted {
                received_ms,
                duplicate,
            } => {
                let batch = request.batch.as_ref().ok_or(Error::State)?;
                state.batches.retain(|b| b.id != batch.id);
                if !duplicate {
                    state.authority.as_mut().ok_or(Error::State)?.last_remote_ms = received_ms;
                }
                if state.batches.is_empty() {
                    state.next_close_ms =
                        Some(now.saturating_add(policy::limits().upload_interval_seconds * 1000));
                }
            }
            Response::Deleted | Response::Missing => {
                state.authority = None;
                state.deletion = if matches!(response, Response::Deleted) {
                    DeletionStatus::Confirmed
                } else {
                    DeletionStatus::NoActiveRecord
                };
            }
        }
        state.failures = 0;
        state.next_attempt_ms =
            now.saturating_add(policy::limits().minimum_attempt_interval_seconds * 1000);
        Ok(match request.kind {
            Kind::Register => Action::Registered,
            Kind::Upload => Action::Accepted,
            Kind::Delete => Action::DeletionComplete,
        })
    }
}

#[cfg(test)]
mod tests;
