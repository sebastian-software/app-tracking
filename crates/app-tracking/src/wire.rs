use crate::{CLOCK_SKEW, DAY, Error, HOUR, NETWORK_BUDGET, Tool, cache::State};
use serde::{Deserialize, Serialize};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use ureq::http::Uri;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub(crate) struct Release {
    schema_version: u32,
    tool_id: String,
    distribution: String,
    channel: String,
    pub latest_version: String,
    published_at: String,
    pub release_url: String,
    checked_at: String,
    pub stale: bool,
}

fn timestamp(value: &str) -> Result<u64, Error> {
    if !value.ends_with('Z') {
        return Err(Error::InvalidResponse);
    }
    let date = OffsetDateTime::parse(value, &Rfc3339).map_err(|_| Error::InvalidResponse)?;
    u64::try_from(date.unix_timestamp()).map_err(|_| Error::InvalidResponse)
}

impl Release {
    pub fn checked_seconds(&self) -> Result<u64, Error> {
        timestamp(&self.checked_at)
    }

    pub fn validate(&self, tool: &Tool, now: u64) -> Result<(), Error> {
        let version =
            semver::Version::parse(&self.latest_version).map_err(|_| Error::InvalidResponse)?;
        let checked = self.checked_seconds()?;
        let published = timestamp(&self.published_at)?;
        let url: Uri = self
            .release_url
            .parse()
            .map_err(|_| Error::InvalidResponse)?;
        if self.schema_version != 1
            || self.tool_id != tool.id
            || self.distribution != tool.distribution
            || self.channel != tool.channel
            || !version.pre.is_empty()
            || url.scheme_str() != Some("https")
            || url.authority().is_none_or(|a| a.as_str().contains('@'))
            || self.release_url.contains('#')
            || self.release_url.chars().any(char::is_control)
            || checked > now.saturating_add(CLOCK_SKEW)
            || published > checked.saturating_add(CLOCK_SKEW)
            || now.saturating_sub(checked) >= DAY
        {
            return Err(Error::InvalidResponse);
        }
        Ok(())
    }
}

pub(crate) fn valid_etag(value: &str) -> bool {
    let tag = value.strip_prefix("W/").unwrap_or(value);
    value.len() <= 256
        && tag.len() >= 2
        && tag.starts_with('"')
        && tag.ends_with('"')
        && tag[1..tag.len() - 1]
            .bytes()
            .all(|b| b == 0x21 || (0x23..=0x7e).contains(&b))
}

pub(crate) fn fetch(
    resource: &str,
    tool: &Tool,
    state: &State,
    now: u64,
) -> Result<(Release, Option<String>), Error> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(NETWORK_BUDGET))
        .max_redirects(0)
        .http_status_as_error(false)
        .max_response_header_size(16_384)
        .user_agent("app-tracking-update-client")
        .build()
        .into();
    let mut request = agent.get(resource).header("Accept", "application/json");
    let cached = state
        .release
        .as_ref()
        .filter(|release| release.validate(tool, now).is_ok());
    if cached.is_some()
        && let Some(etag) = &state.etag
    {
        request = request.header("If-None-Match", etag);
    }
    let mut response = request.call().map_err(|_| Error::Network)?;
    let etag = response
        .headers()
        .get("etag")
        .and_then(|v| v.to_str().ok())
        .filter(|v| valid_etag(v))
        .map(str::to_owned);
    let release = match response.status().as_u16() {
        200 => {
            let content_type = response
                .headers()
                .get("content-type")
                .and_then(|h| h.to_str().ok())
                .unwrap_or("");
            if content_type.split(';').next().map(str::trim) != Some("application/json") {
                return Err(Error::InvalidResponse);
            }
            let bytes = response
                .body_mut()
                .with_config()
                .limit(16_384)
                .read_to_vec()
                .map_err(|_| Error::Network)?;
            serde_json::from_slice::<Release>(&bytes).map_err(|_| Error::InvalidResponse)?
        }
        304 => cached.cloned().ok_or(Error::InvalidResponse)?,
        status => return Err(Error::HttpStatus(status)),
    };
    release.validate(tool, now)?;
    // A stale flag must never turn an expired/future result into a fresh success.
    if !release.stale && now.saturating_sub(release.checked_seconds()?) >= HOUR + CLOCK_SKEW {
        return Err(Error::InvalidResponse);
    }
    Ok((
        release,
        etag.or_else(|| {
            state
                .etag
                .clone()
                .filter(|_| response.status().as_u16() == 304)
        }),
    ))
}
