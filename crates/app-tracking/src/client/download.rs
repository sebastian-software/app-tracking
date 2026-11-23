use super::{Client, Dimensions, Error, endpoint};
use sha2::{Digest, Sha256};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::{Duration, Instant};

/// Cooperatively checked between bounded reads; the deadline also bounds a
/// currently blocked network read. Dropping a partial result removes its file.
#[derive(Debug, Default, Clone)]
pub struct Cancellation(Arc<AtomicBool>);
impl Cancellation {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Relaxed);
    }
    fn check(&self) -> Result<(), Error> {
        if self.0.load(Ordering::Relaxed) {
            Err(Error::Cancelled)
        } else {
            Ok(())
        }
    }
}

#[derive(Debug, Clone)]
pub struct DownloadOptions {
    pub timeout: Duration,
    pub max_bytes: u64,
    pub cancellation: Cancellation,
}
impl Default for DownloadOptions {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(60),
            max_bytes: 128 * 1024 * 1024,
            cancellation: Cancellation::default(),
        }
    }
}

fn resource_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-".contains(&b))
}

fn digest_shape(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Caller-owned resource descriptor. No identity/credential is sent to its URL.
/// Redirects, userinfo, query strings, and fragments are deliberately unsupported.
pub struct Resource {
    url: String,
    id: String,
    bytes: u64,
    sha256: String,
    report: Option<(String, Dimensions)>,
}
impl std::fmt::Debug for Resource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Resource([redacted descriptor])")
    }
}
impl Resource {
    pub fn new(id: &str, url: &str, bytes: u64, sha256: &str) -> Result<Self, Error> {
        if !resource_id(id) || !endpoint(url, false) || !digest_shape(sha256) {
            return Err(Error::Configuration);
        }
        Ok(Self {
            url: url.into(),
            id: id.into(),
            bytes,
            sha256: sha256.into(),
            report: None,
        })
    }

    /// Attach a registered observation. Its collection route comes from the
    /// client's catalog; the resource URL/digest never become implicit labels.
    pub fn reporting(mut self, metric: &str, dimensions: Dimensions) -> Self {
        self.report = Some((metric.into(), dimensions));
        self
    }
}

/// Pinned artifact fetched through a trusted issuer and a fixed CDN origin.
pub struct SignedResource {
    id: String,
    issuer_url: String,
    cdn_origin: String,
    path: String,
    bytes: Option<u64>,
    sha256: String,
    report: Option<(String, Dimensions)>,
}
impl std::fmt::Debug for SignedResource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SignedResource([redacted descriptor])")
    }
}
impl SignedResource {
    /// Pass `None` for a content-pinned manifest whose size is known by the issuer.
    pub fn new(
        id: &str,
        issuer_url: &str,
        cdn_origin: &str,
        path: &str,
        bytes: Option<u64>,
        sha256: &str,
    ) -> Result<Self, Error> {
        if !resource_id(id)
            || !endpoint(issuer_url, false)
            || !issuer_url
                .parse::<ureq::http::Uri>()
                .is_ok_and(|uri| uri.path() == "/v1/downloads")
            || !endpoint(cdn_origin, true)
            || !digest_shape(sha256)
            || path.len() > 240
            || !path.strip_prefix('/').is_some_and(|tail| {
                tail.split('/').all(|part| {
                    !part.is_empty()
                        && part != "."
                        && part != ".."
                        && part
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
                })
            })
        {
            return Err(Error::Configuration);
        }
        Ok(Self {
            id: id.into(),
            issuer_url: issuer_url.into(),
            cdn_origin: cdn_origin.trim_end_matches('/').into(),
            path: path.into(),
            bytes,
            sha256: sha256.into(),
            report: None,
        })
    }

    /// Observe a verified transfer via the client's separate reporting policy.
    pub fn reporting(mut self, metric: &str, dimensions: Dimensions) -> Self {
        self.report = Some((metric.into(), dimensions));
        self
    }
}

#[derive(serde::Deserialize)]
struct Grant {
    url: String,
    bytes: u64,
    sha256: String,
}

fn valid_signed_url(url: &str, prefix: &str) -> bool {
    let Some(query) = url.strip_prefix(prefix) else {
        return false;
    };
    let mut parts = query.split('&');
    let (Some(first), Some(second), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    let token = |field: &str| {
        field.strip_prefix("token=HS256-").is_some_and(|value| {
            value.len() == 43
                && value
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        })
    };
    let expiry = |field: &str| {
        field.strip_prefix("expires=").is_some_and(|value| {
            !value.is_empty()
                && value.len() <= 13
                && !value.starts_with('0')
                && value.bytes().all(|b| b.is_ascii_digit())
        })
    };
    (token(first) && expiry(second)) || (token(second) && expiry(first))
}

fn agent(timeout: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        .max_redirects(0)
        .max_response_header_size(16_384)
        .http_status_as_error(false)
        .user_agent("app-tracking-resource-client")
        .build()
        .into()
}

fn check_response(response: &ureq::http::Response<ureq::Body>) -> Result<(), Error> {
    if response.status().as_u16() != 200 {
        return Err(Error::HttpStatus(response.status().as_u16()));
    }
    if response
        .headers()
        .get("content-encoding")
        .is_some_and(|v| v != "identity")
    {
        return Err(Error::Integrity);
    }
    Ok(())
}

/// A completely verified temporary artifact. The host owns cache placement.
pub struct VerifiedDownload {
    file: tempfile::NamedTempFile,
    id: String,
    bytes: u64,
    sha256: String,
}
impl std::fmt::Debug for VerifiedDownload {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VerifiedDownload")
            .field("bytes", &self.bytes)
            .finish_non_exhaustive()
    }
}
impl VerifiedDownload {
    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn len(&self) -> u64 {
        self.bytes
    }
    pub fn is_empty(&self) -> bool {
        self.bytes == 0
    }
    pub fn sha256(&self) -> &str {
        &self.sha256
    }
    pub fn path(&self) -> &Path {
        self.file.path()
    }
    pub fn reader(&mut self) -> Result<&mut std::fs::File, Error> {
        self.file
            .as_file_mut()
            .seek(SeekFrom::Start(0))
            .map_err(|_| Error::DownloadStorage)?;
        Ok(self.file.as_file_mut())
    }
}

impl Client {
    /// Download bytes needed by the caller. Statistics failures never change
    /// a verified result. Cache hits are handled by the host without this call.
    pub fn download(
        &self,
        resource: &Resource,
        options: &DownloadOptions,
    ) -> Result<VerifiedDownload, Error> {
        if self.policy.offline {
            return Err(Error::Offline);
        }
        check_download(Some(resource.bytes), options)?;
        let result = transfer(resource, options, options.timeout)?;
        self.observe_download(&resource.report);
        Ok(result)
    }

    /// Authorize and verify a signed download within one deadline.
    ///
    /// The build token is sent only to the issuer. Reporting remains optional.
    pub fn download_signed(
        &self,
        resource: &SignedResource,
        build_token: &str,
        options: &DownloadOptions,
    ) -> Result<VerifiedDownload, Error> {
        if self.policy.offline {
            return Err(Error::Offline);
        }
        let result = download_signed(resource, build_token, options)?;
        self.observe_download(&resource.report);
        Ok(result)
    }

    fn observe_download(&self, report: &Option<(String, Dimensions)>) {
        if let Some((metric, values)) = report {
            let _ = self.record(metric, || values.clone());
            let _ = self.flush_in_background();
        }
    }
}

/// Fetch a signed resource without creating or using a reporting client.
///
/// The caller handles cache and offline policy before calling this function.
pub fn download_signed(
    resource: &SignedResource,
    build_token: &str,
    options: &DownloadOptions,
) -> Result<VerifiedDownload, Error> {
    if !digest_shape(build_token) {
        return Err(Error::Configuration);
    }
    check_download(resource.bytes, options)?;
    let started = Instant::now();
    let request = serde_json::json!({ "path": resource.path, "sha256": resource.sha256 });
    let mut response = agent(options.timeout)
        .post(&resource.issuer_url)
        .header("Authorization", format!("Bearer {build_token}"))
        .header("Content-Type", "application/json")
        .header("Accept-Encoding", "identity")
        .send(request.to_string())
        .map_err(|_| Error::Network)?;
    check_response(&response)?;
    let mut bytes = Vec::new();
    let mut reader = response.body_mut().as_reader().take(8_193);
    let mut buffer = [0u8; 2_048];
    loop {
        options.cancellation.check()?;
        let read = reader.read(&mut buffer).map_err(|_| Error::Network)?;
        if read == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..read]);
    }
    options.cancellation.check()?;
    if bytes.len() > 8_192 {
        return Err(Error::Network);
    }
    let grant: Grant = serde_json::from_slice(&bytes).map_err(|_| Error::Integrity)?;
    if grant.bytes == 0
        || grant.bytes > options.max_bytes
        || resource.bytes.is_some_and(|bytes| bytes != grant.bytes)
        || resource.sha256 != grant.sha256
        || !valid_signed_url(
            &grant.url,
            &format!("{}{}?", resource.cdn_origin, resource.path),
        )
    {
        return Err(Error::Integrity);
    }
    let remaining = options
        .timeout
        .checked_sub(started.elapsed())
        .filter(|duration| !duration.is_zero())
        .ok_or(Error::Network)?;
    transfer(
        &Resource {
            url: grant.url,
            id: resource.id.clone(),
            bytes: grant.bytes,
            sha256: grant.sha256,
            report: None,
        },
        options,
        remaining,
    )
}

fn check_download(bytes: Option<u64>, options: &DownloadOptions) -> Result<(), Error> {
    options.cancellation.check()?;
    if bytes.is_some_and(|bytes| bytes > options.max_bytes)
        || options.timeout.is_zero()
        || options.timeout > Duration::from_secs(600)
    {
        return Err(Error::Configuration);
    }
    Ok(())
}

fn transfer(
    resource: &Resource,
    options: &DownloadOptions,
    timeout: Duration,
) -> Result<VerifiedDownload, Error> {
    options.cancellation.check()?;
    let mut response = agent(timeout)
        .get(&resource.url)
        .header("Accept-Encoding", "identity")
        .call()
        .map_err(|_| Error::Network)?;
    check_response(&response)?;
    if let Some(length) = response.headers().get("content-length") {
        let length = length
            .to_str()
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .ok_or(Error::Integrity)?;
        if length != resource.bytes {
            return Err(Error::Integrity);
        }
    }
    let mut file = tempfile::NamedTempFile::new().map_err(|_| Error::DownloadStorage)?;
    let mut reader = response.body_mut().as_reader();
    let mut digest = Sha256::new();
    let mut total = 0u64;
    let mut buffer = [0u8; 16_384];
    loop {
        options.cancellation.check()?;
        let n = reader.read(&mut buffer).map_err(|_| Error::Network)?;
        if n == 0 {
            break;
        }
        total = total.checked_add(n as u64).ok_or(Error::Integrity)?;
        if total > resource.bytes || total > options.max_bytes {
            return Err(Error::Integrity);
        }
        digest.update(&buffer[..n]);
        file.write_all(&buffer[..n])
            .map_err(|_| Error::DownloadStorage)?;
    }
    options.cancellation.check()?;
    let actual: String = digest
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    if total != resource.bytes || actual != resource.sha256 {
        return Err(Error::Integrity);
    }
    file.as_file()
        .sync_all()
        .map_err(|_| Error::DownloadStorage)?;
    Ok(VerifiedDownload {
        file,
        id: resource.id.clone(),
        bytes: total,
        sha256: actual,
    })
}
