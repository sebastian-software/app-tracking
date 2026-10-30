use super::*;
use serde_json::{Value, json};
use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::mpsc;
use std::thread;
use std::time::Instant;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

fn fixture() -> Value {
    serde_json::from_str(include_str!("../fixtures/version.json")).unwrap()
}
fn now() -> u64 {
    OffsetDateTime::parse(fixture()["checked_at"].as_str().unwrap(), &Rfc3339)
        .unwrap()
        .unix_timestamp()
        .try_into()
        .unwrap()
}
fn tool(installed: &str) -> Tool {
    Tool::new("dalo", installed, "npm", "stable").unwrap()
}
fn client(base: &str, dir: &Path, installed: &str) -> UpdateClient {
    UpdateClient::new(base, dir, tool(installed)).unwrap()
}
use std::path::Path;

// A real TCP/HTTP boundary catches parser, header, timeout, and redirect behavior.
fn server(
    status: u16,
    body: String,
    extra: &str,
    delay: Duration,
) -> (String, mpsc::Receiver<String>, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let headers = extra.to_owned();
    let (tx, rx) = mpsc::channel();
    let join = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut request = Vec::new();
        let mut byte = [0];
        while !request.ends_with(b"\r\n\r\n") {
            if stream.read(&mut byte).unwrap_or(0) == 0 {
                break;
            }
            request.push(byte[0]);
        }
        let _ = tx.send(String::from_utf8(request).unwrap());
        thread::sleep(delay);
        let response = format!(
            "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n{body}",
            body.len()
        );
        let _ = stream.write_all(response.as_bytes());
    });
    (origin, rx, join)
}

#[test]
fn service_statistics_opt_out_preserves_update_delivery() {
    let (base, request, join) = server(200, fixture().to_string(), "", Duration::ZERO);
    let dir = tempfile::tempdir().unwrap();
    assert!(
        client(&base, dir.path(), "1.0.0")
            .with_service_metrics(false)
            .check_at(Mode::Enabled, now())
            .unwrap()
            .is_some()
    );
    let request = request.recv().unwrap().to_lowercase();
    assert!(request.contains("dnt: 1\r\n"));
    assert!(!request.contains("authorization:"));
    assert!(!request.contains("cookie:"));
    join.join().unwrap();
}

#[test]
fn semver_precedence_is_local_and_build_metadata_does_not_create_updates() {
    for (installed, expected) in [
        ("1.2.2", true),
        ("1.2.3-beta.1", true),
        ("1.2.3", false),
        ("1.2.3+local", false),
        ("1.3.0-beta.1", false),
        ("2.0.0", false),
    ] {
        let (base, request, join) = server(
            200,
            fixture().to_string(),
            "ETag: W/\"fixture\"\r\n",
            Duration::ZERO,
        );
        let dir = tempfile::tempdir().unwrap();
        let result = client(&base, dir.path(), installed)
            .check_at(Mode::Enabled, now())
            .unwrap();
        assert_eq!(result.is_some(), expected, "{installed}");
        let request = request.recv().unwrap().to_lowercase();
        assert!(request.starts_with("get /v1/versions/dalo/npm/stable http/1.1\r\n"));
        assert!(!request.contains(installed));
        assert!(!request.contains("authorization:"));
        assert!(!request.contains("cookie:"));
        assert!(request.contains("user-agent: app-tracking-update-client\r\n"));
        join.join().unwrap();
    }
}

#[test]
fn cached_result_and_notice_are_shared_across_invocations_and_survive_upgrades() {
    let (base, _, join) = server(200, fixture().to_string(), "", Duration::ZERO);
    let dir = tempfile::tempdir().unwrap();
    assert!(
        client(&base, dir.path(), "1.0.0")
            .check_at(Mode::Enabled, now())
            .unwrap()
            .is_some()
    );
    join.join().unwrap(); // Further calls must not need the now-closed listener.
    assert!(
        client(&base, dir.path(), "1.0.0")
            .check_at(Mode::Enabled, now() + 1)
            .unwrap()
            .is_none()
    );
    assert!(
        client(&base, dir.path(), "1.2.3")
            .check_at(Mode::Enabled, now() + 2)
            .unwrap()
            .is_none()
    );
}

#[test]
fn disabled_and_offline_have_no_network_or_filesystem_side_effect() {
    let dir = tempfile::tempdir().unwrap();
    let absent = dir.path().join("absent");
    let client = client("http://127.0.0.1:1", &absent, "1.0.0");
    for mode in [Mode::Disabled, Mode::Offline] {
        assert!(client.check(mode).unwrap().is_none());
    }
    assert!(!absent.exists());
}

#[test]
fn stale_result_uses_failure_backoff_and_expired_or_mismatched_payloads_are_rejected() {
    let mut stale = fixture();
    stale["stale"] = json!(true);
    let (base, _, join) = server(200, stale.to_string(), "", Duration::ZERO);
    let dir = tempfile::tempdir().unwrap();
    let client = client(&base, dir.path(), "1.0.0");
    let notice = client
        .check_at(Mode::Enabled, now() + HOUR)
        .unwrap()
        .unwrap();
    assert!(notice.stale);
    let state: Value =
        serde_json::from_slice(&fs::read(dir.path().join("dalo.npm.stable.json")).unwrap())
            .unwrap();
    assert_eq!(state["next_check"], now() + HOUR + RETRY_BASE);
    join.join().unwrap();
    let mut invalid = Vec::new();
    let mut prerelease = fixture();
    prerelease["latest_version"] = json!("2.0.0-beta.1");
    invalid.push(prerelease);
    let mut wrong = fixture();
    wrong["tool_id"] = json!("another-tool");
    invalid.push(wrong);
    let mut schema = fixture();
    schema["schema_version"] = json!(2);
    invalid.push(schema);
    let mut unsafe_link = fixture();
    unsafe_link["release_url"] = json!("https://example.com/\u{1b}[31m");
    invalid.push(unsafe_link);
    for payload in invalid {
        let release: crate::wire::Release = serde_json::from_value(payload).unwrap();
        assert!(release.validate(&tool("1.0.0"), now()).is_err());
    }
    let release: crate::wire::Release = serde_json::from_value(stale).unwrap();
    assert!(release.validate(&tool("1.0.0"), now() + DAY).is_err());
    assert!(
        release
            .validate(&tool("1.0.0"), now() - CLOCK_SKEW - 1)
            .is_err()
    );
}

#[test]
fn unsupported_non_json_and_redirect_responses_back_off_without_retries() {
    for status in [404, 429, 503, 302] {
        let (base, _, join) = server(
            status,
            "not JSON".into(),
            "Location: https://example.invalid/\r\n",
            Duration::ZERO,
        );
        let dir = tempfile::tempdir().unwrap();
        let c = client(&base, dir.path(), "1.0.0");
        assert!(
            matches!(c.check_at(Mode::Enabled, now()), Err(Error::HttpStatus(s)) if s == status)
        );
        join.join().unwrap();
        assert!(c.check_at(Mode::Enabled, now() + 1).unwrap().is_none());
    }
}

#[test]
fn truncated_corrupt_and_future_schema_caches_recover() {
    for cache in ["{", "null", "{\"schema_version\":999}"] {
        let (base, _, join) = server(200, fixture().to_string(), "", Duration::ZERO);
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("dalo.npm.stable.json"), cache).unwrap();
        assert!(
            client(&base, dir.path(), "1.0.0")
                .check_at(Mode::Enabled, now())
                .unwrap()
                .is_some()
        );
        let state: Value =
            serde_json::from_slice(&fs::read(dir.path().join("dalo.npm.stable.json")).unwrap())
                .unwrap();
        assert_eq!(state["schema_version"], 1);
        join.join().unwrap();
    }
}

#[test]
fn a_busy_check_never_waits_for_another_holder() {
    let dir = tempfile::tempdir().unwrap();
    let _held = Store::claim(dir.path(), "dalo.npm.stable")
        .unwrap()
        .unwrap();
    let c = client("http://127.0.0.1:1", dir.path(), "1.0.0");
    let start = Instant::now();
    assert!(c.check(Mode::Enabled).unwrap().is_none());
    assert!(start.elapsed() < Duration::from_millis(100));
}

#[test]
fn network_deadline_completes_the_check_and_retains_a_retry_claim() {
    let (base, request, join) = server(200, fixture().to_string(), "", Duration::from_millis(400));
    let dir = tempfile::tempdir().unwrap();
    let c = client(&base, dir.path(), "1.0.0");
    let start = Instant::now();
    assert!(matches!(
        c.check_at(Mode::Enabled, now()),
        Err(Error::Network)
    ));
    let elapsed = start.elapsed();
    assert!(
        elapsed >= Duration::from_millis(150) && elapsed < Duration::from_secs(1),
        "{elapsed:?}"
    );
    request.recv().unwrap();
    join.join().unwrap();
    assert!(c.check_at(Mode::Enabled, now() + 1).unwrap().is_none());
    // Failed requests grow their durable backoff without exceeding one hour.
    for (failures, delay) in [
        (1, 300),
        (2, 600),
        (3, 1200),
        (4, 2400),
        (5, 3600),
        (6, 3600),
    ] {
        let mut state = State {
            schema_version: 1,
            resource: base.clone(),
            next_check: 0,
            failures: failures - 1,
            release: None,
            etag: None,
            noticed_version: None,
            noticed_at: 0,
        };
        state.defer(now());
        assert_eq!(state.next_check, now() + delay);
    }
}

#[test]
fn notice_throttle_is_per_version_and_retained_data_expires() {
    let c = client("http://127.0.0.1:1", Path::new("unused"), "1.0.0");
    let mut state = State {
        schema_version: 1,
        resource: c.resource.clone(),
        next_check: 0,
        failures: 0,
        release: Some(serde_json::from_value(fixture()).unwrap()),
        etag: None,
        noticed_version: None,
        noticed_at: 0,
    };
    assert!(c.notice(&mut state, now()).is_some());
    assert!(c.notice(&mut state, now() + HOUR).is_none());
    let mut newer = fixture();
    newer["latest_version"] = json!("1.2.4");
    state.release = Some(serde_json::from_value(newer).unwrap());
    assert!(c.notice(&mut state, now() + HOUR).unwrap().stale);
    state.release = Some(serde_json::from_value(fixture()).unwrap());
    assert!(c.notice(&mut state, now() + HOUR + 1).is_none());
    assert!(c.notice(&mut state, now() + DAY).is_none());
}

#[test]
fn rejects_credentials_queries_and_path_injection_in_host_configuration() {
    for origin in [
        "http://example.com",
        "https://user:secret@example.com",
        "https://example.com?x=1",
        "https://example.com/private",
        "https://example.com#x",
    ] {
        assert!(UpdateClient::new(origin, "unused", tool("1.0.0")).is_err());
    }
    assert!(UpdateClient::new("http://[::1]:8787", "unused", tool("1.0.0")).is_ok());
    for id in ["../dalo", "Dalo", "dalo?x", "", "a.b"] {
        assert!(Tool::new(id, "1.0.0", "npm", "stable").is_err());
    }
    assert!(Tool::new("dalo", "v1.0.0", "npm", "stable").is_err());
}

#[test]
fn weak_etags_are_opaque_and_304_needs_a_valid_cached_representation() {
    let (base, request, join) =
        server(304, String::new(), "ETag: W/\"opaque\"\r\n", Duration::ZERO);
    let dir = tempfile::tempdir().unwrap();
    let c = client(&base, dir.path(), "1.2.3");
    let store = Store::claim(dir.path(), "dalo.npm.stable")
        .unwrap()
        .unwrap();
    let mut state = store.load(&c.resource, now());
    state.release = Some(serde_json::from_value(fixture()).unwrap());
    state.etag = Some("W/\"opaque\"".into());
    store.save(&state).unwrap();
    drop(store);
    assert!(
        c.check_at(Mode::Enabled, now() + HOUR + 1)
            .unwrap()
            .is_none()
    );
    assert!(
        request
            .recv()
            .unwrap()
            .contains("if-none-match: W/\"opaque\"\r\n")
    );
    join.join().unwrap();
    let (base, _, join) = server(304, String::new(), "", Duration::ZERO);
    let dir = tempfile::tempdir().unwrap();
    assert!(matches!(
        client(&base, dir.path(), "1.0.0").check_at(Mode::Enabled, now()),
        Err(Error::InvalidResponse)
    ));
    join.join().unwrap();
}

#[test]
fn deadline_includes_body_streaming_and_body_size_is_bounded() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let worker = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut request = Vec::new();
        let mut byte = [0];
        while !request.ends_with(b"\r\n\r\n") {
            stream.read_exact(&mut byte).unwrap();
            request.push(byte[0]);
        }
        stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 999\r\n\r\n{").unwrap();
        thread::sleep(Duration::from_millis(400));
    });
    let dir = tempfile::tempdir().unwrap();
    let start = Instant::now();
    assert!(matches!(
        client(&base, dir.path(), "1.0.0").check_at(Mode::Enabled, now()),
        Err(Error::Network)
    ));
    assert!(start.elapsed() < Duration::from_secs(1));
    worker.join().unwrap();
    let (base, _, join) = server(200, "x".repeat(16_385), "", Duration::ZERO);
    let dir = tempfile::tempdir().unwrap();
    assert!(
        client(&base, dir.path(), "1.0.0")
            .check_at(Mode::Enabled, now())
            .is_err()
    );
    join.join().unwrap();
}

#[test]
fn shared_update_contract_fixtures() {
    let contract: Value =
        serde_json::from_str(include_str!("../fixtures/update-client.json")).unwrap();
    let at = contract["now"].as_u64().unwrap();
    let t = Tool::new("ardo", "1.0.0", "github", "stable").unwrap();
    for case in contract["origins"].as_array().unwrap() {
        assert_eq!(
            UpdateClient::new(case["value"].as_str().unwrap(), "unused", t.clone()).is_ok(),
            case["valid"].as_bool().unwrap(),
            "{case}"
        );
    }
    for case in contract["precedence"].as_array().unwrap() {
        let installed = Version::parse(case["installed"].as_str().unwrap()).unwrap();
        let latest = Version::parse(case["latest"].as_str().unwrap()).unwrap();
        assert_eq!(
            latest.cmp_precedence(&installed).is_gt(),
            case["greater"].as_bool().unwrap(),
            "{case}"
        );
    }
    for v in contract["invalid_versions"].as_array().unwrap() {
        assert!(
            Tool::new("ardo", v.as_str().unwrap(), "github", "stable").is_err(),
            "{v}"
        );
    }
    for case in contract["validation"].as_array().unwrap() {
        let mut value = contract["release"].clone();
        value
            .as_object_mut()
            .unwrap()
            .extend(case["patch"].as_object().unwrap().clone());
        let release: wire::Release = serde_json::from_value(value).unwrap();
        let now = at
            .checked_add_signed(case["offset"].as_i64().unwrap())
            .unwrap();
        assert_eq!(
            release.validate(&t, now).is_ok(),
            case["valid"].as_bool().unwrap(),
            "{case}"
        );
        if case["valid"] == true {
            let fresh = release.stale
                || now.saturating_sub(release.checked_seconds().unwrap()) < HOUR + CLOCK_SKEW;
            assert_eq!(fresh, case["fresh"].as_bool().unwrap(), "{case}");
        }
    }
    let c = UpdateClient::new("https://example.com", "unused", t).unwrap();
    let mut state: State = serde_json::from_value(json!({
        "schema_version": 1, "resource": c.resource, "next_check": 0, "failures": 0,
        "release": null, "etag": null, "noticed_version": null, "noticed_at": 0
    }))
    .unwrap();
    for delay in contract["backoff_seconds"].as_array().unwrap() {
        state.defer(at);
        assert_eq!(state.next_check, at + delay.as_u64().unwrap());
    }
    for case in contract["notices"].as_array().unwrap() {
        let mut value = contract["release"].clone();
        value["latest_version"] = case["latest"].clone();
        state.release = Some(serde_json::from_value(value).unwrap());
        state.noticed_version = case["noticed"].as_str().map(str::to_owned);
        state.noticed_at = at;
        let result = c.notice(&mut state, at + case["offset"].as_u64().unwrap());
        assert_eq!(result.is_some(), case["offer"].as_bool().unwrap(), "{case}");
        if let Some(result) = result {
            assert_eq!(result.stale, case["stale"].as_bool().unwrap());
        }
    }
}

#[test]
fn shared_conditional_response_fixtures() {
    let contract: Value =
        serde_json::from_str(include_str!("../fixtures/update-client.json")).unwrap();
    let at = contract["now"].as_u64().unwrap();
    for case in contract["conditional"].as_array().unwrap() {
        let extra = case["response_etag"]
            .as_str()
            .map(|s| format!("ETag: {s}\r\n"))
            .unwrap_or_default();
        let (base, request, join) = server(304, String::new(), &extra, Duration::ZERO);
        let directory = tempfile::tempdir().unwrap();
        let c = UpdateClient::new(
            &base,
            directory.path(),
            Tool::new("ardo", "1.2.3", "github", "stable").unwrap(),
        )
        .unwrap();
        let store = Store::claim(directory.path(), "ardo.github.stable")
            .unwrap()
            .unwrap();
        let mut state = store.load(&c.resource, at);
        if case["cached"] == true {
            state.release = Some(serde_json::from_value(contract["release"].clone()).unwrap());
        }
        state.etag = case["etag"].as_str().map(str::to_owned);
        store.save(&state).unwrap();
        drop(store);
        let result = c.check_at(Mode::Enabled, at + case["offset"].as_u64().unwrap());
        assert_eq!(
            result.is_ok(),
            case["accepted"].as_bool().unwrap(),
            "{case}"
        );
        let request = request.recv().unwrap();
        if let Some(tag) = case["sent"].as_str() {
            assert!(request.contains(&format!("if-none-match: {tag}\r\n")));
        } else {
            assert!(!request.contains("if-none-match:"));
        }
        if result.is_ok() {
            let store = Store::claim(directory.path(), "ardo.github.stable")
                .unwrap()
                .unwrap();
            let saved = store.load(&c.resource, at);
            assert_eq!(
                saved.etag.as_deref(),
                case["response_etag"].as_str().or(case["etag"].as_str())
            );
            assert_eq!(
                serde_json::to_value(saved.release).unwrap()["checked_at"],
                contract["release"]["checked_at"]
            );
        }
        join.join().unwrap();
    }
}
