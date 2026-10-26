//! Advisory version checks and explicit, consent-gated [`project`] identity.
//! [`telemetry`] supplies an opt-in lifecycle only when explicitly called by a
//! host. No automatic collection, output, environment-variable policy,
//! installation, or background worker is provided.
//!
//! Call [`UpdateClient::check`] once at a host-controlled point in a command. The
//! call completes synchronously; a due request has a 200 ms network deadline.
//! The host chooses the endpoint, cache directory, eligibility, and presentation.
//!
//! ```no_run
//! use app_tracking::{Mode, Tool, UpdateClient};
//!
//! # fn main() -> Result<(), Box<dyn std::error::Error>> {
//! let tool = Tool::new("dalo", "1.0.0", "npm", "stable")?;
//! let client = UpdateClient::new("https://updates.example.com", "/my/cache/updates", tool)?;
//! if let Ok(Some(update)) = client.check(Mode::Enabled) {
//!     eprintln!("Update available: {}. Run: npm install -g getdalo", update.latest_version);
//! }
//! # Ok(())
//! # }
//! ```
mod cache;
pub mod project;
pub mod telemetry;
mod wire;

use std::cmp::Ordering;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use semver::Version;
use ureq::http::Uri;

use cache::{State, Store};

/// Total DNS, connection, TLS, response-header, and response-body network budget.
/// Filesystem scheduling and operating-system overhead are additional.
pub const NETWORK_BUDGET: Duration = Duration::from_millis(200);
const HOUR: u64 = 3_600;
const DAY: u64 = 86_400;
const RETRY_BASE: u64 = 300;
const CLOCK_SKEW: u64 = 300;

/// Explicit host policy. The host maps its configuration/environment to this mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Check when due and offer a notice when its throttle permits.
    Enabled,
    /// Do not access the network or filesystem, or offer a notice.
    Disabled,
    /// Do not access the network or filesystem, or offer a notice.
    Offline,
}

/// Validated host identity. Installed versions remain local.
#[derive(Debug, Clone)]
pub struct Tool {
    id: String,
    installed: Version,
    distribution: String,
    channel: String,
}

impl Tool {
    /// Use the same distribution as the host's installation-aware update guidance.
    /// The current service supports only the stable channel.
    pub fn new(
        id: &str,
        installed: &str,
        distribution: &str,
        channel: &str,
    ) -> Result<Self, Error> {
        if !slug(id, 64) || !slug(distribution, 32) || !slug(channel, 32) {
            return Err(Error::InvalidConfiguration);
        }
        let installed = Version::parse(installed).map_err(|_| Error::InvalidConfiguration)?;
        Ok(Self {
            id: id.into(),
            installed,
            distribution: distribution.into(),
            channel: channel.into(),
        })
    }
}

fn slug(value: &str, limit: usize) -> bool {
    !value.is_empty()
        && value.len() <= limit
        && value.as_bytes()[0].is_ascii_lowercase()
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// An offered notice, throttled across processes to once per release per day.
/// Guidance is supplied and rendered by the host, never received as a command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Update {
    pub latest_version: String,
    pub release_url: String,
    /// The service marked this result stale, or local retention passed one hour.
    pub stale: bool,
}

/// Advisory failures. Hosts should keep their command's output and exit status.
/// Errors intentionally omit response bodies, URLs, and filesystem paths.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum Error {
    #[error("invalid update-check configuration")]
    InvalidConfiguration,
    #[error("update cache unavailable")]
    Cache,
    #[error("update request failed or exceeded its deadline")]
    Network,
    #[error("update service returned HTTP {0}")]
    HttpStatus(u16),
    #[error("invalid update response")]
    InvalidResponse,
}

/// One service origin, tool, distribution, and channel. No request occurs on construction.
#[derive(Debug)]
pub struct UpdateClient {
    resource: String,
    cache_dir: PathBuf,
    tool: Tool,
}

impl UpdateClient {
    /// `origin` must be an HTTPS origin without credentials, query, or fragment.
    /// Plain HTTP is accepted only for numeric loopback integration tests.
    /// Scope `cache_dir` to one endpoint; wrappers/native entry points must share it.
    pub fn new(origin: &str, cache_dir: impl Into<PathBuf>, tool: Tool) -> Result<Self, Error> {
        let base: Uri = origin.parse().map_err(|_| Error::InvalidConfiguration)?;
        let host = base.host().unwrap_or("");
        let loopback = host
            .trim_start_matches('[')
            .trim_end_matches(']')
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback());
        if !(base.scheme_str() == Some("https") || (base.scheme_str() == Some("http") && loopback))
            || base.authority().is_none_or(|a| a.as_str().contains('@'))
            || base.query().is_some()
            || origin.contains('#')
            || base.path() != "/"
        {
            return Err(Error::InvalidConfiguration);
        }
        let resource = format!(
            "{}/v1/versions/{}/{}/{}",
            origin.trim_end_matches('/'),
            tool.id,
            tool.distribution,
            tool.channel
        );
        Ok(Self {
            resource,
            cache_dir: cache_dir.into(),
            tool,
        })
    }

    /// Complete an eligible check before returning. No detached update thread is used.
    ///
    /// `Ok(None)` means current, throttled, disabled/offline, or another process
    /// owns the check. A successful fresh lookup suppresses requests for one hour.
    /// Failures/stale responses back off for 5, 10, 20, 40, then 60 minutes.
    /// A persistent pre-request claim also suppresses retries after abrupt exit.
    pub fn check(&self, mode: Mode) -> Result<Option<Update>, Error> {
        if mode != Mode::Enabled {
            return Ok(None);
        }
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| Error::InvalidConfiguration)?
            .as_secs();
        self.check_at(mode, now)
    }

    fn check_at(&self, mode: Mode, now: u64) -> Result<Option<Update>, Error> {
        if mode != Mode::Enabled {
            return Ok(None);
        }
        let file = format!(
            "{}.{}.{}",
            self.tool.id, self.tool.distribution, self.tool.channel
        );
        let Some(store) = Store::claim(&self.cache_dir, &file)? else {
            return Ok(None);
        };
        let mut state = store.load(&self.resource, now);
        let due = now >= state.next_check;
        if due {
            // Persist the claim before opening a connection. If the process dies,
            // a following invocation will not immediately create another request.
            state.defer(now);
            store.save(&state)?;
            match wire::fetch(&self.resource, &self.tool, &state, now) {
                Ok((release, etag)) => {
                    state.etag = etag;
                    if !release.stale {
                        state.failures = 0;
                        state.next_check = now.saturating_add(HOUR + 1);
                    }
                    state.release = Some(release);
                }
                Err(error) => {
                    // The pre-request claim and bounded backoff are already durable.
                    return Err(error);
                }
            }
        }
        let update = self.notice(&mut state, now);
        if due || update.is_some() {
            store.save(&state)?;
        }
        Ok(update)
    }

    fn notice(&self, state: &mut State, now: u64) -> Option<Update> {
        let release = state.release.as_ref()?;
        release.validate(&self.tool, now).ok()?;
        let latest = Version::parse(&release.latest_version).ok()?;
        if latest.cmp_precedence(&self.tool.installed) != Ordering::Greater {
            return None;
        }
        if state
            .noticed_version
            .as_deref()
            .and_then(|v| Version::parse(v).ok())
            .is_some_and(|noticed| latest.cmp_precedence(&noticed) != Ordering::Greater)
            && now.saturating_sub(state.noticed_at) < DAY
        {
            return None;
        }
        state.noticed_version = Some(release.latest_version.clone());
        state.noticed_at = now;
        Some(Update {
            latest_version: release.latest_version.clone(),
            release_url: release.release_url.clone(),
            stale: release.stale || now.saturating_sub(release.checked_seconds().ok()?) >= HOUR,
        })
    }
}

#[cfg(test)]
mod tests;
