//! Unified counter and resource client with library-owned persistent settings.
//!
//! `request_opt_in` owns the permission dialog and saved choice; `record` and
//! `download` apply it. `set_opt_in` supports explicit settings changes.
//! Metrics declare their collection route and finite dimensions at construction.
//! Import/construction never collects information or creates state. Reporting
//! uses the event-batch contract, independently of the legacy CLI-only API.

mod download;
mod history;
mod permission;
mod state;
mod system;
mod worker;

pub use download::{Cancellation, DownloadOptions, Resource, VerifiedDownload};
pub use history::{HISTORY_CONSENT_REVISION, HistoryPermissionStatus};
pub use permission::{Interaction, OptInDecision, PermissionOutcome};
pub use system::{LinuxInfo, SystemInfo};
pub use worker::BACKGROUND_WORKER_ARGUMENT;

use crate::telemetry::Policy;
use serde::{Deserialize, Serialize};
use state::{State, Store};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

/// Finite categorical values only; the metric definition validates every key.
pub type Dimensions = BTreeMap<String, String>;

/// Per-metric policy, not a per-call override of the saved user decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Collection {
    OptOut,
    OptIn,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SystemContext {
    #[default]
    None,
    /// OS family and executable architecture.
    Platform,
    /// Also coarse OS version and CPU family/generation.
    Full,
}

/// A counter definition shared with the receiver's registered metric catalog.
#[derive(Debug, Clone, Serialize)]
pub struct Metric {
    id: String,
    collection: Collection,
    dimensions: BTreeMap<String, Vec<String>>,
    system: SystemContext,
    project: bool,
}

impl Metric {
    pub fn counter(id: &str, collection: Collection) -> Result<Self, Error> {
        if !label(id, 64) {
            return Err(Error::Configuration);
        }
        Ok(Self {
            id: id.into(),
            collection,
            dimensions: BTreeMap::new(),
            system: SystemContext::None,
            project: false,
        })
    }

    /// Add one required dimension with an explicit, bounded value vocabulary.
    pub fn dimension(mut self, name: &str, values: &[&str]) -> Result<Self, Error> {
        if !label(name, 32)
            || self.dimensions.len() >= 8
            || self.dimensions.contains_key(name)
            || values.is_empty()
            || values.len() > 256
            || values.iter().any(|v| !label(v, 64))
        {
            return Err(Error::Configuration);
        }
        let mut allowed: Vec<_> = values.iter().map(|s| (*s).to_owned()).collect();
        allowed.sort();
        allowed.dedup();
        if allowed.len() != values.len() {
            return Err(Error::Configuration);
        }
        self.dimensions.insert(name.into(), allowed);
        Ok(self)
    }

    pub fn system_context(mut self, context: SystemContext) -> Self {
        self.system = context;
        self
    }

    pub fn project_context(mut self) -> Result<Self, Error> {
        if self.collection != Collection::OptIn {
            return Err(Error::Configuration);
        }
        self.project = true;
        Ok(self)
    }

    fn valid(&self, values: &Dimensions) -> bool {
        values.len() == self.dimensions.len()
            && self
                .dimensions
                .iter()
                .all(|(key, allowed)| values.get(key).is_some_and(|value| allowed.contains(value)))
    }
}

#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum Error {
    #[error("invalid client, metric, or resource configuration")]
    Configuration,
    #[error("private client state unavailable or invalid")]
    State,
    #[error("client state is busy")]
    Busy,
    #[error("client clock outside supported range")]
    Clock,
    #[error("secure randomness unavailable")]
    Randomness,
    #[error("delete the previous reporting identity before renewing an expired grant")]
    PreviousIdentity,
    #[error("background reporting worker unavailable")]
    Background,
    #[error("additional permission requires an active usage-reporting grant")]
    AdditionalPermission,
    #[error("permission dialog input or output unavailable")]
    Interaction,
    #[error("resource unavailable in offline mode")]
    Offline,
    #[error("resource download cancelled")]
    Cancelled,
    #[error("resource request failed or exceeded its deadline")]
    Network,
    #[error("resource server returned HTTP {0}")]
    HttpStatus(u16),
    #[error("resource size or SHA-256 verification failed")]
    Integrity,
    #[error("temporary resource storage unavailable")]
    DownloadStorage,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Recorded {
    Counted,
    Suppressed,
    CapacityReached,
}

#[derive(Debug, Serialize)]
pub struct Status {
    pub opt_in: bool,
    pub decision: OptInDecision,
    pub collect_opt_in: bool,
    pub disabled: bool,
    pub deletion_pending: bool,
    pub open_dimensions: usize,
    pub queued_batches: usize,
    pub dropped: u64,
}

type ProjectSource = Box<dyn FnOnce() -> crate::project::RepositoryContext + Send>;

/// A single tool/service/profile. Clone-free construction has no side effects.
pub struct Client {
    origin: String,
    directory: PathBuf,
    tool: String,
    version: String,
    metrics: BTreeMap<String, Metric>,
    opt_in_scope: String,
    policy: Policy,
    interaction: Interaction,
    system: OnceLock<SystemInfo>,
    project: OnceLock<Option<crate::project::ProjectIdentity>>,
    project_source: Mutex<Option<ProjectSource>>,
}

impl std::fmt::Debug for Client {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Client([redacted configuration])")
    }
}

pub(super) fn label(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value.as_bytes()[0].is_ascii_lowercase()
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-".contains(&b))
}

pub(super) fn endpoint(value: &str, origin_only: bool) -> bool {
    let Ok(uri) = value.parse::<ureq::http::Uri>() else {
        return false;
    };
    let loopback = uri
        .host()
        .unwrap_or("")
        .trim_start_matches('[')
        .trim_end_matches(']')
        .parse::<std::net::IpAddr>()
        .is_ok_and(|ip| ip.is_loopback());
    (uri.scheme_str() == Some("https") || (uri.scheme_str() == Some("http") && loopback))
        && uri.authority().is_some_and(|a| !a.as_str().contains('@'))
        && uri.query().is_none()
        && !value.contains('#')
        && (!origin_only || uri.path() == "/")
}

pub(super) fn now() -> Result<u64, Error> {
    let duration = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| Error::Clock)?;
    u64::try_from(duration.as_millis()).map_err(|_| Error::Clock)
}

pub(super) fn random() -> Result<String, Error> {
    let mut bytes = [0; 32];
    getrandom::fill(&mut bytes).map_err(|_| Error::Randomness)?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

pub(super) fn hash(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

impl Client {
    /// Use the shipped product definitions. A matching server catalog must be
    /// deployed before emitting newly registered metrics.
    pub fn registered(
        origin: &str,
        state_root: impl Into<PathBuf>,
        tool: &str,
        version: &str,
    ) -> Result<Self, Error> {
        #[derive(Deserialize)]
        struct Definition {
            collection: Collection,
            dimensions: BTreeMap<String, Vec<String>>,
            system: SystemContext,
            #[serde(default)]
            project: bool,
        }
        #[derive(Deserialize)]
        struct Catalog {
            tools: BTreeMap<String, BTreeMap<String, Definition>>,
        }
        let mut catalog: Catalog =
            serde_json::from_str(include_str!("../../fixtures/event-catalog.json"))
                .map_err(|_| Error::Configuration)?;
        let definitions = catalog.tools.remove(tool).ok_or(Error::Configuration)?;
        let mut metrics = Vec::new();
        for (id, definition) in definitions {
            let mut metric =
                Metric::counter(&id, definition.collection)?.system_context(definition.system);
            if definition.project {
                metric = metric.project_context()?;
            }
            for (name, values) in definition.dimensions {
                let refs: Vec<_> = values.iter().map(String::as_str).collect();
                metric = metric.dimension(&name, &refs)?;
            }
            metrics.push(metric);
        }
        Self::new(origin, state_root, tool, version, metrics)
    }

    pub fn new(
        origin: &str,
        state_root: impl Into<PathBuf>,
        tool: &str,
        version: &str,
        metrics: impl IntoIterator<Item = Metric>,
    ) -> Result<Self, Error> {
        if !endpoint(origin, true)
            || !label(tool, 64)
            || version.len() > 128
            || !version.is_ascii()
            || semver::Version::parse(version).is_err()
            || !version
                .split(['.', '-', '+'])
                .take(3)
                .all(|part| part.len() <= 10)
        {
            return Err(Error::Configuration);
        }
        let mut catalog = BTreeMap::new();
        for metric in metrics {
            if catalog.len() >= 128 || catalog.insert(metric.id.clone(), metric).is_some() {
                return Err(Error::Configuration);
            }
        }
        let origin = origin.trim_end_matches('/').to_owned();
        let opt_in_scope = hash(
            &serde_json::to_vec(
                &catalog
                    .values()
                    .filter(|m| m.collection == Collection::OptIn)
                    .collect::<Vec<_>>(),
            )
            .map_err(|_| Error::Configuration)?,
        );
        let directory = state_root
            .into()
            .join(hash(origin.as_bytes()))
            .join(tool)
            .join("events-v1");
        Ok(Self {
            origin,
            directory,
            tool: tool.into(),
            version: version.into(),
            metrics: catalog,
            opt_in_scope,
            policy: Policy::default(),
            interaction: Interaction::Terminal,
            system: OnceLock::new(),
            project: OnceLock::new(),
            project_source: Mutex::new(None),
        })
    }

    /// Process-level restrictions; settings and grants remain library-owned.
    pub fn with_policy(mut self, policy: Policy) -> Self {
        if self.policy.ci {
            self.directory.pop();
        }
        if policy.ci {
            self.directory = self.directory.join("ci");
        }
        self.policy = policy;
        self
    }

    /// Resolve the consuming project lazily, once, after effective opt-in.
    pub fn with_project_context(
        mut self,
        source: impl FnOnce() -> crate::project::RepositoryContext + Send + 'static,
    ) -> Self {
        self.project_source = Mutex::new(Some(Box::new(source)));
        self.project = OnceLock::new();
        self
    }

    fn scope(&self) -> String {
        format!(
            "{}\n{}\n{}",
            self.origin,
            self.tool,
            if self.policy.ci { "ci" } else { "local" }
        )
    }

    fn veto(&self) -> bool {
        self.policy.do_not_track
            || self.policy.host_disabled
            || self.policy.telemetry.as_deref().is_some_and(|s| s != "on")
            || (self.policy.ci
                && (!self.policy.isolated_ci_state
                    || self.policy.ci_revision.as_deref()
                        != Some(crate::telemetry::CONSENT_REVISION)))
    }

    fn allowed(&self, state: &State, collection: Collection) -> bool {
        !self.veto()
            && !state.disabled
            && !state.deleting
            && (collection == Collection::OptOut
                || (state.opt_in == Some(true)
                    && state.opt_in_scope.as_ref() == Some(&self.opt_in_scope)
                    && state.identity.as_ref().is_some_and(|id| {
                        now().is_ok_and(|at| {
                            let activity = id.consented_at.max(id.last_accepted_at);
                            at >= activity && at - activity < 7_776_000_000
                        })
                    })))
    }

    /// Persist an explicit decision. False selects the baseline route and
    /// removes unsent opt-in data; it never enables a declined metric by fallback.
    pub fn set_opt_in(&self, enabled: bool) -> Result<(), Error> {
        let mut store = Store::open(self, true)?.ok_or(Error::State)?;
        let _network = store.network_guard()?;
        self.save_choice(&mut store, enabled)
    }

    fn save_choice(&self, store: &mut Store, enabled: bool) -> Result<(), Error> {
        if enabled
            && (store.state.deleting
                || store.state.identity.as_ref().is_some_and(|id| {
                    now().is_ok_and(|at| {
                        at.saturating_sub(id.consented_at.max(id.last_accepted_at)) >= 7_776_000_000
                    })
                }))
        {
            return Err(Error::PreviousIdentity);
        }
        if store.state.opt_in == Some(enabled)
            && (!enabled || store.state.opt_in_scope.as_ref() == Some(&self.opt_in_scope))
        {
            return Ok(());
        }
        store.state.opt_in = Some(enabled);
        store.state.opt_in_scope = enabled.then(|| self.opt_in_scope.clone());
        store.state.generation = store.state.generation.saturating_add(1);
        store.state.job = None;
        if enabled {
            if store.state.identity.is_none() {
                store.state.identity = Some(state::Identity {
                    id: random()?,
                    token: random()?,
                    consented_at: now()?,
                    last_accepted_at: 0,
                });
            }
        } else {
            store.state.withdraw_history()?;
            store.state.retain(Collection::OptOut);
        }
        store.save()
    }

    /// Stop collection and request authenticated deletion. The background worker
    /// retries bounded deletion pages; settings remain disabled afterward.
    pub fn delete(&self) -> Result<(), Error> {
        let mut store = Store::open(self, true)?.ok_or(Error::State)?;
        let _network = store.network_guard()?;
        store.state.opt_in = Some(false);
        store.state.withdraw_history()?;
        store.state.disabled = true;
        store.state.clear();
        store.state.deleting = store.state.identity.is_some();
        store.state.generation = store.state.generation.saturating_add(1);
        store.state.next_attempt = 0;
        store.save()
    }

    /// Persist an analytics opt-out covering both collection routes.
    pub fn set_disabled(&self, disabled: bool) -> Result<(), Error> {
        let mut store = Store::open(self, true)?.ok_or(Error::State)?;
        let _network = store.network_guard()?;
        store.state.disabled = disabled;
        store.state.generation = store.state.generation.saturating_add(1);
        store.state.job = None;
        if disabled {
            store.state.withdraw_history()?;
            store.state.clear();
        }
        store.save()
    }

    pub fn status(&self) -> Result<Status, Error> {
        let store = self.inspect()?;
        let state = store.as_ref().map(|s| &s.state);
        Ok(Status {
            opt_in: state.is_some_and(|s| s.opt_in == Some(true)),
            decision: OptInDecision::from(state.and_then(|s| s.opt_in)),
            collect_opt_in: state.is_some_and(|s| self.allowed(s, Collection::OptIn)),
            disabled: state.is_some_and(|s| s.disabled),
            deletion_pending: state.is_some_and(|s| s.deleting),
            open_dimensions: state.map_or(0, |s| s.open.len()),
            queued_batches: state.map_or(0, |s| s.batches.len()),
            dropped: state.map_or(0, |s| s.dropped),
        })
    }

    /// Local payload inspection. Never includes the reporting credential.
    pub fn preview(&self) -> Result<String, Error> {
        let store = self.inspect()?;
        let open: Vec<_> = store
            .as_ref()
            .map(|s| s.state.open.values().collect())
            .unwrap_or_default();
        let batches: Vec<serde_json::Value> = store
            .as_ref()
            .map(|s| {
                s.state
                    .batches
                    .iter()
                    .map(|b| serde_json::from_str(&b.body).map_err(|_| Error::State))
                    .collect()
            })
            .transpose()?
            .unwrap_or_default();
        serde_json::to_string(&serde_json::json!({"open": open, "batches": batches}))
            .map_err(|_| Error::State)
    }

    fn inspect(&self) -> Result<Option<Store>, Error> {
        let Some(mut store) = Store::open(self, false)? else {
            return Ok(None);
        };
        store.state.prune(now()? / 86_400_000);
        if !store.state.deleting {
            if self.veto() || store.state.disabled {
                store.state.clear();
            } else if !self.allowed(&store.state, Collection::OptIn) {
                store.state.retain(Collection::OptOut);
            }
        }
        store.save()?;
        Ok(Some(store))
    }

    /// Count locally. The closure and system collectors run only after gating.
    /// Network delivery is scheduled separately with `flush_in_background`.
    pub fn record(
        &self,
        metric: &str,
        values: impl FnOnce() -> Dimensions,
    ) -> Result<Recorded, Error> {
        let definition = self.metrics.get(metric).ok_or(Error::Configuration)?;
        if self.veto() || self.is_background_worker() {
            return Ok(Recorded::Suppressed);
        }
        // Opt-out metrics may create state, but opt-in probes never do so.
        let Some(mut store) = Store::open(self, definition.collection == Collection::OptOut)?
        else {
            return Ok(Recorded::Suppressed);
        };
        if !self.allowed(&store.state, definition.collection) {
            return Ok(Recorded::Suppressed);
        }
        let values = values();
        if !definition.valid(&values) {
            return Err(Error::Configuration);
        }
        let system = match definition.system {
            SystemContext::None => None,
            SystemContext::Platform => Some(system::platform_context()),
            SystemContext::Full => Some(self.system.get_or_init(system::detect).clone()),
        };
        let day = now()? / 86_400_000;
        if store.state.open.values().any(|row| row.day > day)
            || store.state.batches.iter().any(|batch| batch.day > day)
        {
            return Err(Error::Clock);
        }
        store.state.prune(day);
        let project = if definition.project && definition.collection == Collection::OptIn {
            self.project
                .get_or_init(|| {
                    self.project_source.lock().ok().and_then(|mut source| {
                        source
                            .take()
                            .and_then(|source| crate::project::identify(true, source))
                    })
                })
                .as_ref()
        } else {
            None
        };
        let row = state::Row {
            day,
            metric: metric.into(),
            collection: definition.collection,
            tool_version: self.version.clone(),
            dimensions: values,
            system,
            project_id: project.map(|p| p.hash().to_owned()),
            project_id_version: project.map(|p| p.normalization_version()),
            count: 1,
        };
        let key = serde_json::to_string(&row).map_err(|_| Error::State)?;
        let total: u64 = store
            .state
            .open
            .values()
            .filter(|r| r.day == day)
            .map(|r| u64::from(r.count))
            .sum();
        let outcome = if total >= 10_000_000 {
            Recorded::CapacityReached
        } else if let Some(existing) = store.state.open.get_mut(&key) {
            if existing.count >= 1_000_000 {
                Recorded::CapacityReached
            } else {
                existing.count += 1;
                Recorded::Counted
            }
        } else if store.state.open.len() >= 4096 {
            Recorded::CapacityReached
        } else {
            store.state.open.insert(key, row);
            Recorded::Counted
        };
        if outcome == Recorded::CapacityReached {
            store.state.dropped = store.state.dropped.saturating_add(1);
        }
        store.save()?;
        Ok(outcome)
    }
}

#[cfg(test)]
mod tests;
