//! Optional synchronous CLI integration. Hosts select commands, output, and
//! project scope. Construction does no reporting or permission prompting.

use super::{BACKGROUND_WORKER_ARGUMENT, Client, Dimensions, Error, Recorded, Status, Store};
use crate::telemetry::Policy;
use serde::Deserialize;
use std::ffi::{OsStr, OsString};
use std::path::{Component, Path, PathBuf};
use std::sync::LazyLock;
use std::{env, fs, io};

/// Standard disclosure for consumers of the hosted Sebastian Software service.
/// Append it to the tool-specific purpose before asking for consent.
pub fn hosted_reporting_notice() -> &'static str {
    #[derive(Deserialize)]
    struct Notice {
        notice: String,
    }
    static NOTICE: LazyLock<Notice> = LazyLock::new(|| {
        serde_json::from_str(include_str!(
            "../../../../contracts/hosted-reporting-notice.json"
        ))
        .expect("valid packaged reporting notice")
    });
    &NOTICE.notice
}

/// Apply the shared CLI environment vetoes to a host policy. Product flags
/// (including offline mode) are supplied by the host. Environment variables
/// alone never authorize reporting.
pub fn policy_from_environment(policy: Policy) -> Policy {
    resolve_policy(policy, |key| {
        env::var_os(key).map(|value| value.into_string().unwrap_or_else(|_| "invalid".into()))
    })
}

fn resolve_policy(mut policy: Policy, read: impl Fn(&str) -> Option<String>) -> Policy {
    let truthy = |key| {
        read(key)
            .as_deref()
            .is_some_and(|value| !matches!(value, "" | "0" | "false"))
    };
    if let Some(value) = read("APP_TRACKING_TELEMETRY")
        && (value != "on" || policy.telemetry.is_none())
    {
        policy.telemetry = Some(value);
    }
    policy.do_not_track |= truthy("DO_NOT_TRACK");
    policy.ci |= truthy("CI") || truthy("CONTINUOUS_INTEGRATION");
    policy.ci_revision = read("APP_TRACKING_CI").or(policy.ci_revision);
    policy
}

/// Resolve a per-tool reporting root using the current platform conventions.
/// This computes a path without creating any files. Continue to pass the
/// existing root when adopting the CLI helper in a released consumer.
pub fn default_state_root(tool: &str) -> Option<PathBuf> {
    if !super::label(tool, 64) {
        return None;
    }
    let absolute_env = |key| {
        env::var_os(key)
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
    };
    let base = if cfg!(windows) {
        absolute_env("LOCALAPPDATA")?
    } else {
        absolute_env("XDG_STATE_HOME")
            .or_else(|| absolute_env("HOME").map(|home| home.join(".local/state")))?
    };
    Some(base.join(tool).join("app-tracking"))
}

/// Validate an existing private CI directory selected for this job. A CI root
/// must be separate from the personal state tree. On Unix the directory must
/// be owned by the current user and grant no group or other permissions.
pub fn validate_ci_state_root(root: &Path, personal: Option<&Path>) -> Result<PathBuf, Error> {
    if !root.is_absolute() || root.components().any(|part| part == Component::ParentDir) {
        return Err(Error::Configuration);
    }
    let root = root.components().collect::<PathBuf>();
    let metadata = fs::symlink_metadata(&root).map_err(|_| Error::State)?;
    if !metadata.is_dir() {
        return Err(Error::State);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if metadata.permissions().mode() & 0o077 != 0
            || metadata.uid() != rustix::process::geteuid().as_raw()
        {
            return Err(Error::State);
        }
    }
    let canonical = fs::canonicalize(root).map_err(|_| Error::State)?;
    if let Some(personal) = personal {
        let personal = canonical_prefix(personal)?;
        if canonical.starts_with(&personal) || personal.starts_with(&canonical) {
            return Err(Error::Configuration);
        }
    }
    Ok(canonical)
}

fn canonical_prefix(path: &Path) -> Result<PathBuf, Error> {
    if !path.is_absolute() || path.components().any(|part| part == Component::ParentDir) {
        return Err(Error::Configuration);
    }
    match fs::canonicalize(path) {
        Ok(path) => Ok(path),
        Err(error) if error.kind() == io::ErrorKind::NotFound && !path.is_symlink() => {
            let parent = path.parent().ok_or(Error::State)?;
            Ok(canonical_prefix(parent)?.join(path.file_name().ok_or(Error::State)?))
        }
        Err(_) => Err(Error::State),
    }
}

/// Run this before the host parses normal CLI options. Arguments start after
/// `argv[0]`. Only a matching reserved argument builds a reporting client.
pub fn handle_worker(
    args: impl IntoIterator<Item = OsString>,
    client: impl FnOnce() -> Result<Client, Error>,
) -> Option<Result<bool, Error>> {
    let mut args = args.into_iter();
    if args.next().as_deref() != Some(OsStr::new(BACKGROUND_WORKER_ARGUMENT)) {
        return None;
    }
    let nonce = args.next();
    Some(
        nonce
            .as_deref()
            .and_then(OsStr::to_str)
            .filter(|_| args.next().is_none())
            .ok_or(Error::Background)
            .and_then(|nonce| client()?.run_background_worker(nonce)),
    )
}

/// Outcome of a CLI observation against a registered metric.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InvocationRecorded {
    /// One observation attempt reached the reporting client.
    Reporting(Recorded),
    /// This lifecycle already attempted an observation.
    AlreadyRecorded,
    /// The host already completed this invocation.
    Completed,
}

/// One explicit deletion request and its local worker handoff.
pub struct DeletionRequest {
    /// Persisted status captured before the worker can acquire the state lock.
    pub status: Status,
    /// Whether the client handed off work. Delivery remains pending until the
    /// service acknowledges it.
    pub handed_off: Result<bool, Error>,
}

/// One command's reporting lifecycle. Recording and completion stay silent.
/// The host owns command output and exit status. When a wrapper launches a
/// native command, choose one reporting owner.
pub struct CliClient {
    reporting: Client,
    recorded: bool,
    completed: bool,
}

impl CliClient {
    /// Use an existing configured client and its current storage namespace.
    pub fn new(reporting: Client) -> Self {
        Self {
            reporting,
            recorded: false,
            completed: false,
        }
    }

    /// Count at most once. The metric and dimensions must match the catalog.
    /// This call neither prompts nor performs network requests.
    pub fn record_invocation(
        &mut self,
        metric: &str,
        dimensions: Dimensions,
    ) -> Result<InvocationRecorded, Error> {
        if !self
            .reporting
            .metrics
            .get(metric)
            .is_some_and(|definition| definition.valid(&dimensions))
        {
            return Err(Error::Configuration);
        }
        if self.completed {
            return Ok(InvocationRecorded::Completed);
        }
        if std::mem::replace(&mut self.recorded, true) {
            return Ok(InvocationRecorded::AlreadyRecorded);
        }
        if self.reporting.veto() {
            // Even in offline mode, apply the process veto to the local queue.
            self.reporting.status()?;
            return Ok(InvocationRecorded::Reporting(Recorded::Suppressed));
        }
        self.reporting
            .record(metric, || dimensions)
            .map(InvocationRecorded::Reporting)
    }

    /// Schedule due work at most once without waiting for delivery.
    pub fn complete(&mut self) -> Result<bool, Error> {
        if std::mem::replace(&mut self.completed, true) {
            return Ok(false);
        }
        self.reporting.flush_in_background()
    }

    /// Inspect the ordinary reporting decision and queue.
    pub fn status(&self) -> Result<Status, Error> {
        self.reporting.status()
    }

    /// Inspect local payloads without their credentials.
    pub fn preview(&self) -> Result<String, Error> {
        self.reporting.preview()
    }

    /// Ask for a fresh choice from explicit settings, with the SDK dialog.
    pub fn request_reporting_opt_in_in_settings(
        &self,
        reason: &str,
    ) -> Result<super::PermissionOutcome, Error> {
        self.reporting.request_opt_in_in_settings(reason)
    }

    /// Apply the operator's explicit informed CI choice. Configure a validated
    /// per-job root and the current revision first. Use only from a dedicated
    /// settings action, never on an ordinary CI command.
    pub fn enable_ci_reporting(&self) -> Result<Status, Error> {
        if !self.reporting.policy.ci
            || self.reporting.veto()
            || self.reporting.is_background_worker()
        {
            return Err(Error::Configuration);
        }
        let mut store = Store::open(&self.reporting, true)?.ok_or(Error::State)?;
        let network = store.network_guard()?;
        self.reporting.save_settings_choice(&mut store, true)?;
        drop(network);
        drop(store);
        self.status()
    }

    /// Withdraw ordinary permission and discard unsent usage.
    pub fn withdraw_reporting(&self) -> Result<Status, Error> {
        self.reporting.set_opt_in(false)?;
        self.status()
    }

    /// Disable reporting and discard unsent usage.
    pub fn disable_reporting(&self) -> Result<Status, Error> {
        self.reporting.set_disabled(true)?;
        self.status()
    }

    /// Persist deletion before attempting a worker handoff. Retry an existing
    /// request without clearing its backoff or claiming acknowledgement.
    pub fn delete_reporting(&self) -> Result<DeletionRequest, Error> {
        self.reporting.delete()?;
        let status = self.status()?;
        Ok(DeletionRequest {
            status,
            handed_off: self.reporting.flush_in_background(),
        })
    }
}

#[cfg(test)]
mod tests;
