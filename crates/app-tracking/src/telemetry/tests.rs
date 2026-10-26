use super::*;
use crate::project::{Origin, RepositoryContext};
use serde_json::{Value, json};
use state::{DAY_MS, INACTIVITY_MS};

const NOW: u64 = 1_793_102_400_000; // 2026-10-27T00:00:00Z; synthetic clock.

fn context() -> RepositoryContext {
    RepositoryContext {
        origin: Origin::Present(
            "https://synthetic:credential@github.com/example-org/example-project.git".into(),
        ),
        package_json: None,
    }
}

fn invocation() -> Option<Invocation<'static>> {
    Some(Invocation {
        command: "sync",
        tool_version: "1.10.0",
    })
}

fn fixture() -> (tempfile::TempDir, Client, Policy) {
    let root = tempfile::tempdir().unwrap();
    let client = Client::new("https://example.invalid", root.path(), "dalo").unwrap();
    (root, client, Policy::default())
}

fn load(client: &Client, policy: &Policy) -> State {
    let store = Store::claim(&client.directory(policy), false)
        .unwrap()
        .unwrap();
    client.load(&store, policy).unwrap()
}

fn registered(client: &Client, policy: &Policy) {
    client.control_at(Control::Enable, policy, NOW).unwrap();
    let result = client
        .run_at(policy, invocation(), context, false, NOW, |r, _| {
            assert!(matches!(r.kind, Kind::Register));
            assert_eq!(wire::birth(&r.id), Some(NOW));
            assert!(wire::hex(&r.token, 64));
            Response::Registered
        })
        .unwrap();
    assert_eq!(result.action, Action::Registered);
}

#[test]
fn consent_fixtures_match_the_actual_policy() {
    let cases: Vec<Value> =
        serde_json::from_str(include_str!("../../fixtures/consent-cases.json")).unwrap();
    for c in cases {
        let mut s = State::new("synthetic");
        s.decision = match c["state"].as_str() {
            Some("enabled") => Decision::Enabled,
            Some("declined") => Decision::Declined,
            Some("withdrawn") => Decision::Withdrawn,
            _ => Decision::Undecided,
        };
        if s.decision == Decision::Enabled {
            s.grant = Some(Grant {
                revision: c["revision"].as_str().unwrap_or(CONSENT_REVISION).into(),
                source: if c["grant_source"] == "environment" {
                    GrantSource::Environment
                } else {
                    GrantSource::Explicit
                },
                at_ms: NOW,
            });
        }
        let p = Policy {
            do_not_track: c["do_not_track"] == true,
            environment_consent: c["environment_consent"].as_str().map(str::to_owned),
            offline: c["offline"] == true,
            ci: c["ci"] == true,
            ci_revision: c["ci_revision"].as_str().map(str::to_owned),
            isolated_ci_state: c["isolated_ci_state"] == true,
            ..Policy::default()
        };
        match c["action"].as_str() {
            Some("withdraw") => s.withdraw(Decision::Withdrawn, NOW),
            Some("delete" | "reset") => {
                s.withdraw(Decision::Withdrawn, NOW);
                s.deletion = DeletionStatus::Pending;
            }
            _ => {}
        }
        let result = policy::effective(&s, &p);
        assert_eq!(
            (result.collect, result.upload, result.delete),
            (
                c["expected"]["collect"] == true,
                c["expected"]["upload"] == true,
                c["expected"]["delete"] == true
            ),
            "{}",
            c["name"]
        );
    }
}

#[test]
fn no_state_identity_or_project_discovery_before_consent() {
    let (root, client, policy) = fixture();
    assert!(matches!(
        client
            .run_at(
                &policy,
                invocation(),
                || panic!("must not discover"),
                true,
                NOW,
                |_, _| panic!("must not send")
            )
            .unwrap()
            .action,
        Action::Suppressed
    ));
    assert!(
        !root
            .path()
            .join(wire::sha256(client.origin.as_bytes()))
            .exists()
    );
    assert_eq!(
        client.status(&policy).unwrap().decision,
        Decision::Undecided
    );
    assert!(!client.preview(&policy).unwrap().contains("credential"));
    assert!(!client.directory(&policy).exists());
    let mut p = policy.clone();
    p.environment_consent = Some("true".into());
    client
        .run_at(&p, invocation(), || panic!(), false, NOW, |_, _| panic!())
        .unwrap();
    assert!(!client.directory(&policy).exists());
}

#[test]
fn offline_consent_counts_without_remote_identity_then_registers_once() {
    let (_, client, mut p) = fixture();
    p.offline = true;
    client.control_at(Control::Enable, &p, NOW).unwrap();
    assert!(load(&client, &p).authority.is_none());
    assert!(
        client
            .run_at(&p, invocation(), context, true, NOW, |_, _| panic!())
            .unwrap()
            .counted
    );
    assert!(load(&client, &p).authority.is_none());
    p.offline = false;
    assert_eq!(
        client
            .run_at(
                &p,
                None,
                || panic!(),
                true,
                NOW + 1000,
                |_, _| Response::Registered
            )
            .unwrap()
            .action,
        Action::Registered
    );
    assert_eq!(load(&client, &p).open.len(), 1);
    client
        .run_at(
            &p,
            None,
            || panic!(),
            true,
            NOW + 1001,
            |_, _| panic!("registration cannot immediately upload"),
        )
        .unwrap();
}

#[test]
fn immutable_batch_retries_preserve_concurrent_counts_and_verify_acknowledgements() {
    let (_, client, p) = fixture();
    registered(&client, &p);
    let mut first_body = String::new();
    let result = client.run_at(&p, None, || panic!(), true, NOW + 60_000, |r, _| {
        first_body = r.body.clone();
        let ack = json!({"schema_version":1,"installation_id":r.id,"batch_id":r.batch.as_ref().unwrap().id,"status":"accepted","payload_sha256":"0".repeat(64),"received_at":wire::timestamp(NOW+60_000).unwrap()});
        assert!(wire::acknowledgement(r, 200, ack.to_string().as_bytes(), NOW+60_000).is_none());
        // A separate invocation can acquire the state lock while HTTP is in flight.
        client.run_at(&p, invocation(), context, false, NOW + 60_001, |_, _| panic!()).unwrap();
        Response::Retry(None) // committed server result, lost ACK
    }).unwrap();
    assert_eq!(result.action, Action::RetryScheduled);
    let s = load(&client, &p);
    assert_eq!(s.batches.len(), 1);
    assert_eq!(s.open.values().map(|r| r.count).sum::<u32>(), 1);
    client
        .run_at(
            &p,
            None,
            || panic!(),
            false,
            NOW + 120_000,
            |r, _| {
                assert_eq!(r.body, first_body);
                Response::Accepted {
                    received_ms: NOW + 60_000,
                    duplicate: true,
                }
            },
        )
        .unwrap();
    let s = load(&client, &p);
    assert!(s.batches.is_empty());
    assert_eq!(s.open.values().map(|r| r.count).sum::<u32>(), 1);
    assert_eq!(
        s.authority.unwrap().last_remote_ms,
        NOW,
        "duplicate must not renew authority"
    );
}

#[test]
fn withdrawal_and_late_ack_cannot_restore_usage_or_consent() {
    let (_, client, p) = fixture();
    registered(&client, &p);
    let mut ticket = None;
    client
        .run_at(
            &p,
            None,
            || panic!(),
            true,
            NOW + 60_000,
            |request, _| {
                ticket = Some(request.clone());
                assert!(
                    matches!(
                        client.control_at(Control::Withdraw, &p, NOW + 60_001),
                        Err(Error::Busy)
                    ),
                    "control cannot commit across a starting/in-flight request"
                );
                Response::Retry(None)
            },
        )
        .unwrap();
    client
        .control_at(Control::Withdraw, &p, NOW + 60_002)
        .unwrap();
    let late = client
        .acknowledge(
            &p,
            &ticket.unwrap(),
            Response::Accepted {
                received_ms: NOW + 60_000,
                duplicate: false,
            },
            NOW + 60_003,
        )
        .unwrap();
    assert_eq!(late, Action::Suppressed);
    let s = load(&client, &p);
    assert_eq!(s.decision, Decision::Withdrawn);
    assert!(s.open.is_empty() && s.batches.is_empty());
    assert!(s.authority.unwrap().declaration.is_empty());
    client
        .run_at(
            &p,
            invocation(),
            || panic!(),
            true,
            NOW + 120_000,
            |_, _| panic!(),
        )
        .unwrap();
}

#[test]
fn environment_grant_has_immutable_declaration_and_does_not_persist_permission() {
    let (_, client, mut p) = fixture();
    p.environment_consent = Some(CONSENT_REVISION.into());
    let mut original = String::new();
    client
        .run_at(&p, invocation(), context, false, NOW, |r, _| {
            original = r.body.clone();
            Response::Retry(None)
        })
        .unwrap();
    let id = load(&client, &p).authority.unwrap().id;
    p.environment_consent = None;
    client
        .run_at(
            &p,
            invocation(),
            || panic!(),
            false,
            NOW + 60_000,
            |_, _| panic!(),
        )
        .unwrap();
    assert!(load(&client, &p).open.is_empty());
    p.environment_consent = Some(CONSENT_REVISION.into());
    client
        .run_at(&p, invocation(), context, false, NOW + 120_000, |r, _| {
            assert_eq!(r.id, id);
            assert_eq!(r.body, original);
            Response::Registered
        })
        .unwrap();
    p.do_not_track = true;
    client
        .run_at(
            &p,
            invocation(),
            || panic!(),
            true,
            NOW + 180_000,
            |_, _| panic!(),
        )
        .unwrap();
    assert!(load(&client, &p).open.is_empty());
    p.do_not_track = false;
    client
        .control_at(Control::Decline, &p, NOW + 180_000)
        .unwrap();
    client
        .run_at(
            &p,
            invocation(),
            || panic!(),
            true,
            NOW + 240_000,
            |_, _| panic!(),
        )
        .unwrap();
}

#[test]
fn delete_pending_offline_dnt_retry_and_unverified_reset_boundaries() {
    let (_, client, mut p) = fixture();
    registered(&client, &p);
    p.offline = true;
    client.control_at(Control::Reset, &p, NOW + 1000).unwrap();
    assert_eq!(load(&client, &p).deletion, DeletionStatus::Pending);
    assert!(matches!(
        client.control_at(Control::Enable, &p, NOW + 1000),
        Err(Error::PreviousIdentity)
    ));
    client
        .run_at(
            &p,
            invocation(),
            || panic!(),
            false,
            NOW + 2000,
            |_, _| panic!(),
        )
        .unwrap();
    p.offline = false;
    p.do_not_track = true;
    client
        .run_at(
            &p,
            None,
            || panic!(),
            false,
            NOW + 3000,
            |r, _| {
                assert!(matches!(r.kind, Kind::Delete));
                assert!(r.body.is_empty());
                Response::Retry(Some(120))
            },
        )
        .unwrap();
    client.control_at(Control::Delete, &p, NOW + 4000).unwrap();
    client
        .run_at(
            &p,
            None,
            || panic!(),
            true,
            NOW + 4000,
            |_, _| panic!("repeat deletion cannot reset suppression"),
        )
        .unwrap();
    client
        .run_at(
            &p,
            None,
            || panic!(),
            false,
            NOW + 123_000,
            |_, _| Response::Deleted,
        )
        .unwrap();
    assert_eq!(load(&client, &p).deletion, DeletionStatus::Confirmed);
    assert!(load(&client, &p).authority.is_none());
    p.do_not_track = false;
    registered(&client, &p);
    client.control_at(Control::Delete, &p, NOW + 1000).unwrap();
    client
        .run_at(
            &p,
            None,
            || panic!(),
            false,
            NOW + 1000 + INACTIVITY_MS,
            |_, _| panic!(),
        )
        .unwrap();
    assert_eq!(load(&client, &p).deletion, DeletionStatus::Unverified);
    assert!(load(&client, &p).authority.is_none());
}

#[test]
fn terminal_outcomes_pause_without_new_identity_and_expiry_clears_usage() {
    for status in [400, 401, 404, 409, 410, 413, 415] {
        let (_, client, p) = fixture();
        registered(&client, &p);
        let id = load(&client, &p).authority.unwrap().id;
        client
            .run_at(
                &p,
                None,
                || panic!(),
                true,
                NOW + 60_000,
                |_, _| Response::Terminal(status),
            )
            .unwrap();
        client
            .run_at(
                &p,
                invocation(),
                || panic!(),
                true,
                NOW + DAY_MS,
                |_, _| panic!(),
            )
            .unwrap();
        let s = load(&client, &p);
        assert_eq!(s.authority.unwrap().id, id);
        assert_eq!(s.terminal_status, Some(status));
        if status == 410 {
            assert!(s.batches.is_empty() && s.open.is_empty());
        }
    }
    let (_, client, mut p) = fixture();
    p.offline = true;
    client.control_at(Control::Enable, &p, NOW).unwrap();
    client
        .run_at(&p, invocation(), context, false, NOW, |_, _| panic!())
        .unwrap();
    client
        .run_at(
            &p,
            invocation(),
            || panic!(),
            true,
            NOW + INACTIVITY_MS,
            |_, _| panic!(),
        )
        .unwrap();
    assert_eq!(load(&client, &p).decision, Decision::Expired);
    assert!(load(&client, &p).open.is_empty());
}

#[test]
fn registration_unknown_outcome_and_crash_claim_reuse_authority() {
    let (_, client, p) = fixture();
    client.control_at(Control::Enable, &p, NOW).unwrap();
    // Failure after the durable pre-request claim stands in for abrupt exit.
    let crashed = std::panic::catch_unwind(|| {
        client.run_at(&p, invocation(), context, false, NOW, |_, _| {
            panic!("crash after persisted claim")
        })
    });
    assert!(crashed.is_err());
    let before = load(&client, &p).authority.unwrap();
    client
        .run_at(
            &p,
            invocation(),
            context,
            false,
            NOW + 1000,
            |_, _| panic!(),
        )
        .unwrap();
    client
        .run_at(
            &p,
            None,
            || panic!(),
            false,
            NOW + 60_000,
            |r, _| {
                assert_eq!(r.id, before.id);
                assert_eq!(r.token, before.token);
                assert_eq!(r.body, before.declaration);
                Response::Registered
            },
        )
        .unwrap();
}

#[test]
fn retry_sequence_and_retry_after_never_bypass_suppression() {
    let (_, client, p) = fixture();
    client.control_at(Control::Enable, &p, NOW).unwrap();
    let mut now = NOW;
    for seconds in [60, 300, 1800, 3600, 21600, 86400, 86400] {
        client
            .run_at(&p, invocation(), context, true, now, |_, _| {
                Response::Retry(None)
            })
            .unwrap();
        let s = load(&client, &p);
        assert_eq!(s.next_attempt_ms, now + seconds * 1000);
        client
            .run_at(
                &p,
                None,
                || panic!(),
                true,
                s.next_attempt_ms - 1,
                |_, _| panic!(),
            )
            .unwrap();
        now = s.next_attempt_ms;
    }
}

#[test]
fn payloads_match_golden_jcs_hash_and_reject_null_project_fields() {
    let f: Value = serde_json::from_str(include_str!("../../fixtures/telemetry-v1.json")).unwrap();
    let rows: Vec<Row> = serde_json::from_value(f["batch"]["rows"].clone()).unwrap();
    let body = wire::batch_body(
        "dalo",
        f["installation_id"].as_str().unwrap(),
        f["batch"]["batch_id"].as_str().unwrap(),
        &rows,
    )
    .unwrap();
    assert_eq!(body, f["canonical_utf8"]);
    assert_eq!(wire::sha256(body.as_bytes()), f["payload_sha256"]);
    let mut invalid = f["batch"]["rows"][0].clone();
    invalid["project_id"] = Value::Null;
    assert!(serde_json::from_value::<Row>(invalid).is_err());
}

#[test]
fn queue_limits_expiry_and_counts_are_bounded_before_submission() {
    let mut s = State::new("synthetic");
    s.authority = Some(Authority {
        id: wire::uuid7(NOW).unwrap(),
        token: wire::token().unwrap(),
        declaration: String::new(),
        registered: true,
        last_remote_ms: NOW,
    });
    for i in 0..300 {
        let row = Row {
            day: wire::day(NOW).unwrap(),
            tool_version: format!("1.0.0+{i}{}", "x".repeat(110)),
            command: "sync".into(),
            count: 1,
            project_id: Some("a".repeat(64)),
            project_id_version: Some(1),
        };
        s.open.insert(row.dimension().unwrap(), row);
    }
    s.close("dalo", NOW).unwrap();
    assert!(s.batches.len() > 1);
    assert_eq!(s.batches.iter().map(|b| b.count).sum::<u64>(), 300);
    assert!(s.batches.iter().all(|b| b.body.len() <= 65_536
        && wire::valid_batch(b, "dalo", &s.authority.as_ref().unwrap().id)));
    let batch = s.batches[0].clone();
    for _ in 0..100 {
        s.batches.push(batch.clone());
    }
    s.bound().unwrap();
    assert!(s.batches.len() <= 64);
    assert!(serde_json::to_vec(&s).unwrap().len() <= 4_194_304);
    assert!(s.dropped_invocations > 0);
    s.prune(NOW + 8 * DAY_MS).unwrap();
    assert!(s.batches.is_empty());
}

#[test]
fn preview_redacts_token_and_corruption_never_silently_resets_identity() {
    let (_, client, p) = fixture();
    registered(&client, &p);
    let authority = load(&client, &p).authority.unwrap();
    let secret = authority.token.clone();
    let preview = client.preview(&p).unwrap();
    for raw in [&secret, "credential", "github.com", "example-org"] {
        assert!(!preview.contains(raw));
    }
    let path = client.directory(&p).join("state.json");
    std::fs::write(&path, "{truncated").unwrap();
    assert!(matches!(
        client.run_at(&p, invocation(), || panic!(), false, NOW, |_, _| panic!()),
        Err(Error::State)
    ));
    assert_eq!(std::fs::read_to_string(path).unwrap(), "{truncated");
    let recovered = client
        .control_at(Control::ForgetUnverified, &p, NOW + 1000)
        .unwrap();
    assert_eq!(recovered.deletion, DeletionStatus::Unverified);
    assert_eq!(recovered.decision, Decision::Withdrawn);
    assert!(load(&client, &p).authority.is_none());
    client.control_at(Control::Enable, &p, NOW + 2000).unwrap();
    let mut ticket = None;
    client
        .run_at(
            &p,
            None,
            || panic!(),
            false,
            NOW + 2000,
            |r, _| {
                ticket = Some(r.clone());
                Response::Retry(None)
            },
        )
        .unwrap();
    // A lost-state recovery can restart generation/attempt numbers. An ACK
    // must still belong to the exact authority, not merely matching numbers.
    let mut stale = ticket.unwrap();
    stale.id = authority.id;
    stale.token = authority.token;
    stale.body = authority.declaration;
    assert_eq!(
        client
            .acknowledge(&p, &stale, Response::Registered, NOW + 2001)
            .unwrap(),
        Action::Suppressed
    );
    assert!(!load(&client, &p).authority.unwrap().registered);
}

#[test]
fn ci_requires_isolated_explicit_scope_and_does_not_share_local_authority() {
    let (_, client, mut p) = fixture();
    registered(&client, &p);
    let local_id = load(&client, &p).authority.unwrap().id;
    p.ci = true;
    client
        .run_at(&p, invocation(), || panic!(), false, NOW, |_, _| panic!())
        .unwrap();
    assert!(!client.directory(&p).exists());
    p.ci_revision = Some(CONSENT_REVISION.into());
    p.isolated_ci_state = true;
    p.environment_consent = Some(CONSENT_REVISION.into());
    client
        .run_at(&p, invocation(), context, false, NOW, |_, _| {
            Response::Registered
        })
        .unwrap();
    assert_ne!(local_id, load(&client, &p).authority.unwrap().id);
}

#[test]
fn ordinary_daily_cadence_and_explicit_flush_have_independent_suppression() {
    let (_, client, p) = fixture();
    registered(&client, &p);
    for now in [NOW + 60_000, NOW + DAY_MS - 1] {
        client
            .run_at(
                &p,
                None,
                || panic!(),
                false,
                now,
                |_, _| panic!("first ordinary upload is not yet due"),
            )
            .unwrap();
    }
    client
        .run_at(
            &p,
            None,
            || panic!(),
            false,
            NOW + DAY_MS,
            |_, _| Response::Accepted {
                received_ms: NOW + DAY_MS,
                duplicate: false,
            },
        )
        .unwrap();
    client
        .run_at(
            &p,
            invocation(),
            context,
            false,
            NOW + DAY_MS + 1,
            |_, _| panic!(),
        )
        .unwrap();
    client
        .run_at(
            &p,
            None,
            || panic!(),
            true,
            NOW + DAY_MS + 59_999,
            |_, _| panic!("flush cannot bypass suppression"),
        )
        .unwrap();
    assert_eq!(
        client
            .run_at(
                &p,
                None,
                || panic!(),
                true,
                NOW + DAY_MS + 60_000,
                |_, _| Response::Accepted {
                    received_ms: NOW + DAY_MS + 60_000,
                    duplicate: false
                }
            )
            .unwrap()
            .action,
        Action::Accepted
    );
}

#[test]
fn active_offline_usage_cannot_make_an_ancient_first_consent_registrable() {
    let (_, client, p) = fixture();
    let offline = Policy {
        offline: true,
        ..p.clone()
    };
    client.control_at(Control::Enable, &offline, NOW).unwrap();
    client
        .run_at(
            &offline,
            invocation(),
            context,
            false,
            NOW + 89 * DAY_MS,
            |_, _| panic!(),
        )
        .unwrap();
    client
        .run_at(
            &p,
            invocation(),
            || panic!(),
            true,
            NOW + 91 * DAY_MS,
            |_, _| panic!("old first consent needs renewal"),
        )
        .unwrap();
    let state = load(&client, &p);
    assert_eq!(state.decision, Decision::Expired);
    assert!(state.authority.is_none() && state.open.is_empty());
}

#[test]
fn inspection_honors_a_hard_veto_without_persisting_a_refusal() {
    let (_, client, mut p) = fixture();
    registered(&client, &p);
    p.telemetry = Some("unknown-value".into());
    let status = client.status(&p).unwrap();
    assert_eq!(status.effective.reason, "invalid_telemetry_setting");
    assert_eq!(status.unsent_invocations, 0);
    assert_eq!(status.decision, Decision::Enabled);
    assert!(load(&client, &p).open.is_empty());
    p.telemetry = None;
    assert!(
        client
            .run_at(
                &p,
                invocation(),
                context,
                false,
                NOW + 1000,
                |_, _| panic!()
            )
            .unwrap()
            .counted
    );
    client
        .control_at(Control::Withdraw, &p, NOW + 2000)
        .unwrap();
    let state = load(&client, &p);
    assert_eq!(state.last_invocation_ms, 0);
    assert_eq!(state.authority.unwrap().last_remote_ms, 0);
}

#[test]
fn crashed_uncommitted_write_is_removed_before_withdrawal() {
    let (_, client, p) = fixture();
    registered(&client, &p);
    let directory = client.directory(&p);
    let project = load(&client, &p)
        .open
        .values()
        .next()
        .unwrap()
        .project_id
        .clone()
        .unwrap();
    std::fs::copy(directory.join("state.json"), directory.join("state.new")).unwrap();
    client
        .control_at(Control::Withdraw, &p, NOW + 1000)
        .unwrap();
    assert!(!directory.join("state.new").exists());
    assert!(
        !std::fs::read_to_string(directory.join("state.json"))
            .unwrap()
            .contains(&project)
    );
    assert!(load(&client, &p).open.is_empty());
}

#[cfg(unix)]
#[test]
fn private_files_reject_permissive_permissions_and_dangling_symlinks() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let (root, client, p) = fixture();
    registered(&client, &p);
    let directory = client.directory(&p);
    let state = directory.join("state.json");
    assert_eq!(
        std::fs::metadata(&directory).unwrap().permissions().mode() & 0o077,
        0
    );
    assert_eq!(
        std::fs::metadata(&state).unwrap().permissions().mode() & 0o077,
        0
    );
    std::fs::set_permissions(&state, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert!(matches!(client.status(&p), Err(Error::State)));
    std::fs::remove_file(&state).unwrap();
    let foreign = root.path().join("must-not-create");
    symlink(&foreign, &state).unwrap();
    assert!(matches!(
        client.control_at(Control::Enable, &p, NOW),
        Err(Error::State)
    ));
    assert!(!foreign.exists());
}

fn delete_response(status: &str, headers: &str, body: &str) -> Response {
    use std::io::{Read, Write};
    let server = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", server.local_addr().unwrap());
    let reply = format!(
        "HTTP/1.1 {status}\r\nConnection: close\r\nCache-Control: no-store\r\n{headers}\r\n{body}"
    );
    let thread = std::thread::spawn(move || {
        let (mut socket, _) = server.accept().unwrap();
        socket
            .set_read_timeout(Some(std::time::Duration::from_secs(2)))
            .unwrap();
        let mut bytes = [0; 4096];
        let n = socket.read(&mut bytes).unwrap();
        let request = String::from_utf8_lossy(&bytes[..n]);
        assert!(request.starts_with("DELETE /v1/installations/"));
        assert!(
            request
                .to_ascii_lowercase()
                .contains("user-agent: app-tracking-telemetry-client")
        );
        assert!(!request.to_ascii_lowercase().contains("cookie:"));
        socket.write_all(reply.as_bytes()).unwrap();
    });
    let request = Request {
        generation: 0,
        attempt: 1,
        kind: Kind::Delete,
        id: wire::uuid7(NOW).unwrap(),
        token: wire::token().unwrap(),
        body: String::new(),
        batch: None,
    };
    let result = wire::send(&origin, &request, NOW);
    thread.join().unwrap();
    result
}

#[test]
fn deletion_transport_requires_empty_success_and_validated_missing_record() {
    assert!(matches!(
        delete_response("204 No Content", "", ""),
        Response::Deleted
    ));
    assert!(matches!(
        delete_response("204 No Content", "Content-Length: 1\r\n", "x"),
        Response::Retry(_)
    ));
    let body = r#"{"schema_version":1,"error":{"code":"installation_not_found"}}"#;
    assert!(matches!(
        delete_response(
            "404 Not Found",
            &format!(
                "Content-Type: application/json\r\nContent-Length: {}\r\n",
                body.len()
            ),
            body
        ),
        Response::Missing
    ));
    assert!(
        matches!(
            delete_response("404 Not Found", "Content-Length: 0\r\n", ""),
            Response::Retry(_)
        ),
        "gateway 404 is not a deletion acknowledgement"
    );
    assert!(matches!(
        delete_response(
            "200 OK",
            "Content-Type: application/json\r\nContent-Length: 4096\r\n",
            &"x".repeat(4096)
        ),
        Response::Retry(_)
    ));
}

#[test]
fn telemetry_redirects_never_forward_credentials() {
    let other = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    other.set_nonblocking(true).unwrap();
    assert!(matches!(
        delete_response(
            "307 Temporary Redirect",
            &format!(
                "Location: http://{}/other\r\nContent-Length: 0\r\n",
                other.local_addr().unwrap()
            ),
            ""
        ),
        Response::Retry(_)
    ));
    assert!(matches!(other.accept(), Err(e) if e.kind() == std::io::ErrorKind::WouldBlock));
}
