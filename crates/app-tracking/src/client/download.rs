use super::{Client, Dimensions, Error, endpoint};
use sha2::{Digest, Sha256};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;

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
        if !super::label(id, 128)
            || !endpoint(url, false)
            || sha256.len() != 64
            || !sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
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
        options.cancellation.check()?;
        if resource.bytes > options.max_bytes
            || options.timeout.is_zero()
            || options.timeout > Duration::from_secs(600)
        {
            return Err(Error::Configuration);
        }
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_global(Some(options.timeout))
            .max_redirects(0)
            .max_response_header_size(16_384)
            .http_status_as_error(false)
            .user_agent("app-tracking-resource-client")
            .build()
            .into();
        let mut response = agent
            .get(&resource.url)
            .header("Accept-Encoding", "identity")
            .call()
            .map_err(|_| Error::Network)?;
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
        if let Some((metric, values)) = &resource.report {
            let _ = self.record(metric, || values.clone());
            let _ = self.flush_in_background();
        }
        Ok(VerifiedDownload {
            file,
            id: resource.id.clone(),
            bytes: total,
            sha256: actual,
        })
    }
}
