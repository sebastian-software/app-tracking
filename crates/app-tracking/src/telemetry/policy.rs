use serde::{Deserialize, Serialize};
use std::sync::LazyLock;

pub const CONSENT_REVISION: &str = "telemetry-v1";

/// Host-resolved environment/configuration. No environment is read implicitly.
/// There is deliberately no TTY, JSON, agent, or repository-enable flag.
#[derive(Default, Clone)]
pub struct Policy {
    pub do_not_track: bool,
    pub host_disabled: bool,
    /// APP_TRACKING_TELEMETRY: absent or `on` permits evaluating consent;
    /// `off` or an unrecognized value vetoes collection and discards unsent data.
    pub telemetry: Option<String>,
    /// APP_TRACKING_CONSENT, exactly `telemetry-v1`, is an informed process grant.
    pub environment_consent: Option<String>,
    pub ci: bool,
    /// APP_TRACKING_CI, exactly `telemetry-v1`.
    pub ci_revision: Option<String>,
    /// The host has provided an isolated private state directory for this CI run.
    pub isolated_ci_state: bool,
    /// Disables networking, including deletion; permitted local counting remains.
    pub offline: bool,
}

impl Policy {
    pub(super) fn veto(&self) -> bool {
        self.do_not_track
            || self.host_disabled
            || self.telemetry.as_deref().is_some_and(|s| s != "on")
    }

    pub(super) fn environment_grant(&self) -> bool {
        self.environment_consent.as_deref() == Some(CONSENT_REVISION)
    }

    pub(super) fn context_allowed(&self) -> bool {
        !self.ci
            || (self.ci_revision.as_deref() == Some(CONSENT_REVISION) && self.isolated_ci_state)
    }

    pub(super) fn mode(&self) -> &'static str {
        if self.ci { "ci" } else { "local" }
    }
}

/// An explicit human decision, separate from the current process policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum Decision {
    #[default]
    Undecided,
    Enabled,
    Declined,
    Withdrawn,
    Expired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GrantSource {
    Explicit,
    Environment,
}

/// Inspectable effective policy; `reason` is a fixed vocabulary, never input.
#[derive(Debug, Clone, Serialize)]
pub struct EffectivePolicy {
    pub collect: bool,
    pub upload: bool,
    pub delete: bool,
    pub reason: &'static str,
}

pub(super) fn effective(state: &super::state::State, policy: &Policy) -> EffectivePolicy {
    let reason = if state.terminal_status.is_some() {
        "operation_paused"
    } else if state.deletion == super::DeletionStatus::Pending {
        "pending_deletion"
    } else if policy.do_not_track {
        "do_not_track"
    } else if policy.host_disabled {
        "host_disabled"
    } else if policy.telemetry.as_deref() == Some("off") {
        "environment_disabled"
    } else if policy.telemetry.as_deref().is_some_and(|s| s != "on") {
        "invalid_telemetry_setting"
    } else if !policy.context_allowed() {
        "ci_not_enabled"
    } else if matches!(
        state.decision,
        Decision::Declined | Decision::Withdrawn | Decision::Expired
    ) {
        "no_current_grant"
    } else if let Some(grant) = &state.grant {
        if grant.revision != CONSENT_REVISION {
            "consent_revision_required"
        } else if grant.source == GrantSource::Environment && !policy.environment_grant() {
            "environment_grant_absent"
        } else {
            "permitted"
        }
    } else if state.decision == Decision::Undecided && policy.environment_grant() {
        "permitted"
    } else {
        "no_current_grant"
    };
    let collect = reason == "permitted";
    EffectivePolicy {
        collect,
        upload: collect && !policy.offline,
        delete: state.deletion == super::DeletionStatus::Pending
            && !policy.offline
            && state.terminal_status.is_none(),
        reason,
    }
}

#[derive(Deserialize)]
pub(super) struct Limits {
    pub max_batch_bytes: usize,
    pub max_rows: usize,
    pub max_row_count: u32,
    pub max_batch_count: u64,
    pub max_daily_installation_count: u64,
    pub max_local_bytes: u64,
    pub max_local_batches: usize,
    pub max_local_dimensions: usize,
    pub upload_interval_seconds: u64,
    pub minimum_attempt_interval_seconds: u64,
    pub retry_seconds: Vec<u64>,
    pub tools: std::collections::BTreeMap<String, Commands>,
}

#[derive(Deserialize)]
pub(super) struct Commands {
    pub commands: Vec<String>,
}

pub(super) fn limits() -> &'static Limits {
    static LIMITS: LazyLock<Limits> = LazyLock::new(|| {
        serde_json::from_str(include_str!("../../fixtures/telemetry-v1-policy.json"))
            .expect("packaged telemetry policy is valid JSON")
    });
    &LIMITS
}
