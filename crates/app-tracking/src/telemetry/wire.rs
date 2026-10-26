use super::{CONSENT_REVISION, Error, Row, state::Batch};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

pub(super) fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

pub(super) fn uuid7(now: u64) -> Result<String, Error> {
    if now >= 1 << 48 {
        return Err(Error::Clock);
    }
    let mut bytes = [0; 16];
    getrandom::fill(&mut bytes).map_err(|_| Error::Randomness)?;
    bytes[..6].copy_from_slice(&now.to_be_bytes()[2..]);
    bytes[6] = (bytes[6] & 0x0f) | 0x70;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    ))
}

pub(super) fn token() -> Result<String, Error> {
    let mut bytes = [0; 32];
    getrandom::fill(&mut bytes).map_err(|_| Error::Randomness)?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

fn date(now: u64) -> Result<OffsetDateTime, Error> {
    let date = OffsetDateTime::from_unix_timestamp_nanos(i128::from(now) * 1_000_000)
        .map_err(|_| Error::Clock)?;
    if !(1970..=9999).contains(&date.year()) {
        return Err(Error::Clock);
    }
    Ok(date)
}

pub(super) fn timestamp(now: u64) -> Result<String, Error> {
    let d = date(now)?;
    Ok(format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        d.year(),
        u8::from(d.month()),
        d.day(),
        d.hour(),
        d.minute(),
        d.second(),
        d.millisecond()
    ))
}

pub(super) fn day(now: u64) -> Result<String, Error> {
    let d = date(now)?;
    Ok(format!(
        "{:04}-{:02}-{:02}",
        d.year(),
        u8::from(d.month()),
        d.day()
    ))
}

pub(super) fn parse_timestamp(text: &str) -> Option<u64> {
    let d = OffsetDateTime::parse(text, &Rfc3339).ok()?;
    let ms = u64::try_from(d.unix_timestamp_nanos() / 1_000_000).ok()?;
    (timestamp(ms).ok()?.as_str() == text).then_some(ms)
}

pub(super) fn hex(text: &str, len: usize) -> bool {
    text.len() == len
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub(super) fn birth(id: &str) -> Option<u64> {
    let bytes = id.as_bytes();
    if bytes.len() != 36
        || [8, 13, 18, 23].iter().any(|i| bytes[*i] != b'-')
        || bytes[14] != b'7'
        || !matches!(bytes[19], b'8' | b'9' | b'a' | b'b')
    {
        return None;
    }
    let compact = id.replace('-', "");
    if !hex(&compact, 32) {
        return None;
    }
    u64::from_str_radix(&compact[..12], 16).ok()
}

pub(super) fn valid_day(day: &str) -> bool {
    day.len() == 10 && parse_timestamp(&format!("{day}T00:00:00.000Z")).is_some()
}

pub(super) fn valid_row(row: &Row, tool: &str) -> bool {
    valid_day(&row.day)
        && super::version_valid(&row.tool_version)
        && row.count > 0
        && row.count <= super::policy::limits().max_row_count
        && super::policy::limits()
            .tools
            .get(tool)
            .is_some_and(|c| c.commands.contains(&row.command))
        && match (&row.project_id, row.project_id_version) {
            (None, None) => true,
            (Some(hash), Some(1)) => hex(hash, 64),
            _ => false,
        }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Declaration {
    schema_version: u8,
    tool_id: String,
    consent_revision: String,
    consented_at: String,
    mode: String,
}

pub(super) fn valid_declaration(body: &str, tool: &str, mode: &str) -> bool {
    if body.len() > 1024 {
        return false;
    }
    let Ok(d) = serde_json::from_str::<Declaration>(body) else {
        return false;
    };
    d.schema_version == 1
        && d.tool_id == tool
        && d.consent_revision == CONSENT_REVISION
        && d.mode == mode
        && parse_timestamp(&d.consented_at).is_some()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    schema_version: u8,
    tool_id: String,
    installation_id: String,
    batch_id: String,
    consent_revision: String,
    rows: Vec<Row>,
}

pub(super) fn valid_batch(batch: &Batch, tool: &str, installation: &str) -> bool {
    if batch.body.len() > super::policy::limits().max_batch_bytes {
        return false;
    }
    let Ok(b) = serde_json::from_str::<Envelope>(&batch.body) else {
        return false;
    };
    let count = b.rows.iter().map(|r| u64::from(r.count)).sum::<u64>();
    if b.schema_version != 1
        || b.tool_id != tool
        || b.installation_id != installation
        || b.batch_id != batch.id
        || birth(&b.batch_id) != Some(batch.created_ms)
        || b.consent_revision != CONSENT_REVISION
        || b.rows.is_empty()
        || b.rows.len() > super::policy::limits().max_rows
        || count != batch.count
        || count > super::policy::limits().max_batch_count
        || b.rows.iter().any(|r| !valid_row(r, tool))
        || b.rows.iter().map(|r| &r.day).min() != Some(&batch.oldest_day)
        || sha256(batch.body.as_bytes()) != batch.hash
    {
        return false;
    }
    let keys = b
        .rows
        .iter()
        .map(Row::dimension)
        .collect::<Result<Vec<_>, _>>();
    let Ok(keys) = keys else {
        return false;
    };
    if keys.windows(2).any(|pair| pair[0] >= pair[1]) {
        return false;
    }
    batch_body(tool, installation, &batch.id, &b.rows).is_ok_and(|body| body == batch.body)
}

pub(super) fn canonical(mut value: serde_json::Value) -> Result<String, Error> {
    // All protocol keys/strings are ASCII and numbers are bounded integers.
    // Sort explicitly: consumers can unify serde_json's preserve_order feature.
    value.sort_all_objects();
    serde_json::to_string(&value).map_err(|_| Error::State)
}

pub(super) fn batch_body(
    tool: &str,
    installation: &str,
    id: &str,
    rows: &[Row],
) -> Result<String, Error> {
    let mut rows = rows
        .iter()
        .map(|r| Ok((r.dimension()?, r)))
        .collect::<Result<Vec<_>, Error>>()?;
    rows.sort_by(|a, b| a.0.cmp(&b.0));
    canonical(
        json!({"schema_version":1,"tool_id":tool,"installation_id":installation,"batch_id":id,"consent_revision":CONSENT_REVISION,"rows":rows.into_iter().map(|(_, r)| r).collect::<Vec<_>>() }),
    )
}

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Kind {
    Register,
    Upload,
    Delete,
}

#[derive(Clone)]
pub(super) struct Request {
    pub generation: u64,
    pub attempt: u64,
    pub kind: Kind,
    pub id: String,
    pub token: String,
    pub body: String,
    pub batch: Option<Batch>,
}

pub(super) enum Response {
    Registered,
    Accepted { received_ms: u64, duplicate: bool },
    Deleted,
    Missing,
    Retry(Option<u64>),
    Terminal(u16),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RegistrationAck {
    schema_version: u8,
    installation_id: String,
    status: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BatchAck {
    schema_version: u8,
    installation_id: String,
    batch_id: String,
    status: String,
    payload_sha256: String,
    received_at: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ErrorAck {
    schema_version: u8,
    error: ErrorCode,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ErrorCode {
    code: String,
}

pub(super) fn acknowledgement(
    request: &Request,
    status: u16,
    bytes: &[u8],
    now: u64,
) -> Option<Response> {
    match request.kind {
        Kind::Register => {
            let ack: RegistrationAck = serde_json::from_slice(bytes).ok()?;
            (ack.schema_version == 1
                && ack.installation_id == request.id
                && matches!(
                    (status, ack.status.as_str()),
                    (201, "registered") | (200, "duplicate")
                ))
            .then_some(Response::Registered)
        }
        Kind::Upload => {
            let batch = request.batch.as_ref()?;
            let ack: BatchAck = serde_json::from_slice(bytes).ok()?;
            let received_ms = parse_timestamp(&ack.received_at)?;
            (status == 200
                && ack.schema_version == 1
                && ack.installation_id == request.id
                && ack.batch_id == batch.id
                && ack.payload_sha256 == batch.hash
                && matches!(ack.status.as_str(), "accepted" | "duplicate")
                && received_ms <= now.saturating_add(300_000)
                && received_ms.saturating_add(300_000) >= batch.created_ms)
                .then_some(Response::Accepted {
                    received_ms,
                    duplicate: ack.status == "duplicate",
                })
        }
        Kind::Delete => (status == 204 && bytes.is_empty()).then_some(Response::Deleted),
    }
}

pub(super) fn send(origin: &str, tool: &str, request: &Request, now: u64) -> Response {
    send_with_budget(origin, tool, request, now, crate::NETWORK_BUDGET)
}

pub(super) fn send_with_budget(
    origin: &str,
    tool: &str,
    request: &Request,
    now: u64,
    budget: std::time::Duration,
) -> Response {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(budget))
        .max_redirects(0)
        .http_status_as_error(false)
        .max_response_header_size(16_384)
        .user_agent("app-tracking-telemetry-client")
        .build()
        .into();
    let url = match request.kind {
        Kind::Register | Kind::Delete => format!("{origin}/v1/installations/{}", request.id),
        Kind::Upload => format!("{origin}/v1/usage-batches"),
    };
    let authorization = format!("Bearer {}", request.token);
    let response = match request.kind {
        Kind::Register => agent
            .put(&url)
            .header("Authorization", &authorization)
            .header("Accept", "application/json")
            .header("Content-Type", "application/json")
            .send(request.body.as_bytes()),
        Kind::Upload => agent
            .post(&url)
            .header("Authorization", &authorization)
            .header("Accept", "application/json")
            .header("Content-Type", "application/json")
            .send(request.body.as_bytes()),
        Kind::Delete => agent
            .delete(&url)
            .header("App-Tracking-Tool", tool)
            .header("Authorization", &authorization)
            .header("Accept", "application/json")
            .call(),
    };
    let Ok(mut response) = response else {
        return Response::Retry(None);
    };
    let status = response.status().as_u16();
    if status == 429 || (500..=599).contains(&status) {
        let retry = response
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .filter(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
            .and_then(|v| v.parse::<u64>().ok())
            .map(|n| n.clamp(60, 86_400));
        return Response::Retry(retry);
    }
    let missing = status == 404 && matches!(request.kind, Kind::Delete);
    if !missing && matches!(status, 400 | 401 | 404 | 405 | 409 | 410 | 413 | 415) {
        return Response::Terminal(status);
    }
    if response
        .headers()
        .get("cache-control")
        .and_then(|v| v.to_str().ok())
        != Some("no-store")
    {
        return Response::Retry(None);
    }
    if (!matches!(request.kind, Kind::Delete) || missing)
        && response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.split(';').next())
            .map(str::trim)
            != Some("application/json")
    {
        return Response::Retry(None);
    }
    if status == 204
        && response
            .headers()
            .get("content-length")
            .is_some_and(|v| v.as_bytes() != b"0")
    {
        return Response::Retry(None);
    }
    let Ok(bytes) = response.body_mut().with_config().limit(2_048).read_to_vec() else {
        return Response::Retry(None);
    };
    if missing {
        return if serde_json::from_slice::<ErrorAck>(&bytes)
            .is_ok_and(|e| e.schema_version == 1 && e.error.code == "installation_not_found")
        {
            Response::Missing
        } else {
            Response::Retry(None)
        };
    }
    acknowledgement(request, status, &bytes, now).unwrap_or(Response::Retry(None))
}
