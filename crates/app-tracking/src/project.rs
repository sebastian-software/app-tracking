//! Consent-gated, local project identity. No filesystem, environment, Git command,
//! network, logging, or persistence is performed by this module.
//!
//! The host supplies raw context lazily, after resolving its effective telemetry
//! policy. Update checks never invoke this module. Unknown context is `None`.
//!
//! ```
//! use app_tracking::project::{identify, Origin, RepositoryContext};
//!
//! let collection_allowed = false; // Resolve the host's complete consent policy.
//! let project = identify(collection_allowed, || RepositoryContext {
//!     origin: Origin::Present("git@github.com:example-org/example-project.git".into()),
//!     package_json: None,
//! });
//! assert!(project.is_none());
//! ```

use std::fmt;

use sha2::{Digest, Sha256};

/// The wire normalization version. Canonical bytes are specified in the
/// repository's `docs/project-identity.md` and published JSON fixtures.
pub const NORMALIZATION_VERSION: u8 = 1;
const MAX_URL_BYTES: usize = 8_192;
const MAX_PACKAGE_BYTES: usize = 1_048_576;

/// Result of the host's Git-origin lookup. Lookup failure or multiple origins
/// must be `Unavailable`, never `Absent`; package fallback is allowed only for
/// a confirmed absence. Debug output deliberately hides the raw origin.
#[derive(Clone)]
pub enum Origin {
    /// The checkout has no origin, or this is not a Git checkout.
    Absent,
    /// Exactly one configured origin, without applying Git URL rewrite rules.
    Present(String),
    /// The host could not determine an unambiguous origin.
    Unavailable,
}

impl fmt::Debug for Origin {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Absent => "Absent",
            Self::Present(_) => "Present([redacted])",
            Self::Unavailable => "Unavailable",
        })
    }
}

/// Owned host context, discovered inside the consent-gated closure. Use the
/// package associated with the command, not an arbitrary dependency.
/// `repository.directory` does not divide a monorepo.
/// Debug output never includes metadata, credentials, URLs, or local paths.
#[derive(Clone)]
pub struct RepositoryContext {
    pub origin: Origin,
    /// Complete package.json text, used only when origin is confirmed absent.
    pub package_json: Option<String>,
}

impl fmt::Debug for RepositoryContext {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RepositoryContext")
            .field("origin", &self.origin)
            .field(
                "package_json",
                &self.package_json.as_ref().map(|_| "[redacted]"),
            )
            .finish()
    }
}

/// A known project: SHA-256 of canonical UTF-8 bytes, without a salt, tool ID,
/// newline, or installation identifier. Original metadata is not retained.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectIdentity {
    hash: String,
}

impl ProjectIdentity {
    /// Lowercase 64-character hexadecimal wire `project_id`.
    pub fn hash(&self) -> &str {
        &self.hash
    }

    /// Wire `project_id_version`; versions are not implicitly comparable.
    pub fn normalization_version(&self) -> u8 {
        NORMALIZATION_VERSION
    }
}

/// Invoke context discovery only if the host's effective collection policy
/// permits it, then return a known identity or `None` for unknown/global context.
///
/// `collection_allowed` must include explicit consent, CI policy, withdrawal, and
/// invocation-level suppression. Offline mode may still permit local collection;
/// pass collection permission, not upload permission. This is not a consent
/// store or an upload API.
/// The closure is never called when false. Keep metadata discovery inside it;
/// do not log raw context or errors in the host adapter. All parsing failures
/// become unknown without diagnostics or a directory-name fallback.
pub fn identify(
    collection_allowed: bool,
    context: impl FnOnce() -> RepositoryContext,
) -> Option<ProjectIdentity> {
    if !collection_allowed {
        return None;
    }
    let context = context();
    let canonical = match context.origin {
        Origin::Present(url) => normalize(&url),
        Origin::Unavailable => None,
        Origin::Absent => package_repository(&context.package_json?),
    }?;
    Some(ProjectIdentity {
        hash: Sha256::digest(canonical.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
    })
}

fn package_repository(package: &str) -> Option<String> {
    if package.len() > MAX_PACKAGE_BYTES {
        return None;
    }
    let package: serde_json::Value = serde_json::from_str(package).ok()?;
    let repository = package.get("repository")?;
    let url = if let Some(url) = repository.as_str() {
        url
    } else {
        let object = repository.as_object()?;
        if object.get("type").is_some_and(|kind| kind != "git") {
            return None;
        }
        object.get("url")?.as_str()?
    };
    let expanded = if let Some(path) = url.strip_prefix("github:") {
        format!("https://github.com/{path}")
    } else if let Some(path) = url.strip_prefix("gitlab:") {
        format!("https://gitlab.com/{path}")
    } else if let Some(path) = url.strip_prefix("bitbucket:") {
        format!("https://bitbucket.org/{path}")
    } else if !url.contains(':') && url.split('/').count() == 2 {
        format!("https://github.com/{url}")
    } else {
        return normalize(url);
    };
    normalize(&expanded)
}

fn normalize(input: &str) -> Option<String> {
    if input.is_empty()
        || input.len() > MAX_URL_BYTES
        || !input.is_ascii()
        || input
            .bytes()
            .any(|b| b.is_ascii_whitespace() || b.is_ascii_control())
        || input.contains(['\\', '?', '#'])
    {
        return None;
    }
    let (transport, authority, path) = if let Some((scheme, rest)) = input.split_once("://") {
        let scheme = scheme.to_ascii_lowercase();
        let scheme = scheme.strip_prefix("git+").unwrap_or(&scheme);
        if !matches!(scheme, "https" | "ssh") {
            return None;
        }
        let (authority, path) = rest.split_once('/')?;
        (scheme.to_owned(), authority, path)
    } else {
        let (authority, path) = input.split_once(':')?;
        if path.starts_with('/') {
            return None; // SCP absolute paths have different semantics.
        }
        ("ssh".to_owned(), authority, path)
    };

    // Discard user information before constructing any canonical identity.
    let authority = if let Some((user, host)) = authority.rsplit_once('@') {
        if user.is_empty() || user.contains('@') {
            return None;
        }
        host
    } else {
        authority
    };
    let (host, port) = if let Some((host, port)) = authority.split_once(':') {
        if port.is_empty() || !port.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        let number = port.parse::<u16>().ok()?;
        if number == 0 {
            return None;
        }
        (host.to_ascii_lowercase(), Some(number))
    } else {
        (authority.to_ascii_lowercase(), None)
    };
    if !dns_host(&host) {
        return None;
    }
    let github_ssh_alias = host == "ssh.github.com";
    let host = if github_ssh_alias {
        if transport != "ssh" || port != Some(443) {
            return None;
        }
        "github.com"
    } else {
        host.as_str()
    };
    let hosted = matches!(host, "github.com" | "gitlab.com" | "bitbucket.org");
    if hosted {
        let default_port = if transport == "ssh" { 22 } else { 443 };
        if port.is_some_and(|p| p != default_port) && !github_ssh_alias {
            return None;
        }
        let path = path.strip_suffix('/').unwrap_or(path);
        let path = path.strip_suffix(".git").unwrap_or(path);
        if !repository_path(path) {
            return None;
        }
        let depth = path.split('/').count();
        if depth < 2 || (host != "gitlab.com" && depth != 2) {
            return None;
        }
        let path = if host == "github.com" {
            path.to_ascii_lowercase()
        } else {
            path.to_owned()
        };
        Some(format!("{host}/{path}"))
    } else {
        // Generic SSH paths may be relative to the SSH user's home, and cannot
        // safely discard that user. Only generic HTTPS is supported in v1.
        if transport != "https" || !repository_path(path.strip_suffix('/').unwrap_or(path)) {
            return None;
        }
        let port = port
            .filter(|p| *p != 443)
            .map(|p| format!(":{p}"))
            .unwrap_or_default();
        Some(format!("https://{host}{port}/{path}"))
    }
}

fn dns_host(host: &str) -> bool {
    host.len() <= 253
        && host.contains('.')
        && host
            .rsplit('.')
            .next()
            .is_some_and(|label| label.bytes().any(|b| b.is_ascii_alphabetic()))
        && host.parse::<std::net::IpAddr>().is_err()
        && host.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
}

fn repository_path(path: &str) -> bool {
    path.split('/').all(|part| {
        !part.is_empty()
            && part != "."
            && part != ".."
            && part
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    })
}

#[cfg(test)]
mod tests;
