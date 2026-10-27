use super::*;
use std::io::{Read, Write};
use std::net::TcpListener;

pub(super) fn client(root: &std::path::Path) -> Client {
    Client::new(
        "https://tracking.example",
        root,
        "fixture",
        "2.0.0",
        [
            Metric::counter("basic", Collection::OptOut).unwrap(),
            Metric::counter("rich", Collection::OptIn)
                .unwrap()
                .dimension("format", &["po", "fcl"])
                .unwrap()
                .system_context(SystemContext::Full),
        ],
    )
    .unwrap()
}
pub(super) fn values() -> Dimensions {
    [("format".into(), "po".into())].into()
}

#[test]
fn project_discovery_is_lazy_and_uses_the_shared_repository_hash() {
    use crate::project::{Origin, RepositoryContext};
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    let directory = tempfile::tempdir().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let capture = Arc::clone(&calls);
    let c = Client::new(
        "https://tracking.example",
        directory.path(),
        "fixture",
        "2.0.0",
        [Metric::counter("rich", Collection::OptIn)
            .unwrap()
            .project_context()
            .unwrap()],
    )
    .unwrap()
    .with_project_context(move || {
        capture.fetch_add(1, Ordering::Relaxed);
        RepositoryContext {
            origin: Origin::Present("git@github.com:example/project.git".into()),
            package_json: None,
        }
    });
    c.record("rich", Dimensions::new).unwrap();
    assert_eq!(calls.load(Ordering::Relaxed), 0);
    c.set_opt_in(true).unwrap();
    c.record("rich", Dimensions::new).unwrap();
    c.record("rich", Dimensions::new).unwrap();
    assert_eq!(calls.load(Ordering::Relaxed), 1);
    let expected = crate::project::identify(true, || RepositoryContext {
        origin: Origin::Present("https://github.com/example/project".into()),
        package_json: None,
    })
    .unwrap();
    let preview: serde_json::Value = serde_json::from_str(&c.preview().unwrap()).unwrap();
    assert_eq!(preview["open"][0]["project_id"], expected.hash());
    assert_eq!(preview["open"][0]["count"], 2);
    assert!(!c.preview().unwrap().contains("github.com"));
}

#[test]
fn decision_survives_reconstruction_and_gates_before_collection() {
    let directory = tempfile::tempdir().unwrap();
    let c = client(directory.path());
    assert_eq!(
        c.record("rich", || panic!("must not collect")).unwrap(),
        Recorded::Suppressed
    );
    assert!(!c.directory.exists());
    assert!(c.system.get().is_none());
    assert_eq!(
        c.record("basic", Dimensions::new).unwrap(),
        Recorded::Counted
    );
    c.set_opt_in(true).unwrap();
    let c = client(directory.path());
    assert!(c.status().unwrap().opt_in);
    assert_eq!(c.record("rich", values).unwrap(), Recorded::Counted);
    assert!(c.system.get().is_some());
    c.set_opt_in(false).unwrap();
    let c = client(directory.path());
    assert!(!c.status().unwrap().opt_in);
    assert_eq!(
        c.record("rich", || panic!("must not collect")).unwrap(),
        Recorded::Suppressed
    );
    assert_eq!(c.status().unwrap().open_dimensions, 1);
    c.set_disabled(true).unwrap();
    assert_eq!(
        c.record("basic", || panic!("must not collect")).unwrap(),
        Recorded::Suppressed
    );
    assert_eq!(c.status().unwrap().open_dimensions, 0);
}

#[test]
fn process_vetoes_prevent_probes_and_offline_defers_only_delivery() {
    for policy in [
        Policy {
            do_not_track: true,
            ..Policy::default()
        },
        Policy {
            host_disabled: true,
            ..Policy::default()
        },
        Policy {
            telemetry: Some("invalid".into()),
            ..Policy::default()
        },
        Policy {
            ci: true,
            ..Policy::default()
        },
    ] {
        let directory = tempfile::tempdir().unwrap();
        let c = client(directory.path()).with_policy(policy);
        c.set_opt_in(true).unwrap();
        assert_eq!(
            c.record("basic", || panic!("vetoed collection")).unwrap(),
            Recorded::Suppressed
        );
        assert_eq!(
            c.record("rich", || panic!("vetoed collection")).unwrap(),
            Recorded::Suppressed
        );
        assert!(!c.status().unwrap().collect_opt_in);
        assert!(c.system.get().is_none());
    }
    let directory = tempfile::tempdir().unwrap();
    let c = client(directory.path()).with_policy(Policy {
        offline: true,
        ..Policy::default()
    });
    c.set_opt_in(true).unwrap();
    assert_eq!(c.record("rich", values).unwrap(), Recorded::Counted);
    assert!(!c.schedule(|_| panic!("offline worker launch")).unwrap());
    assert_eq!(c.status().unwrap().open_dimensions, 1);
}

#[cfg(unix)]
#[test]
fn permissive_or_symlinked_state_cannot_be_loaded_or_overwritten() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let directory = tempfile::tempdir().unwrap();
    let c = client(directory.path());
    c.record("basic", Dimensions::new).unwrap();
    let state = c.directory.join("state.json");
    std::fs::set_permissions(&state, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert!(matches!(c.status(), Err(Error::State)));
    std::fs::remove_file(&state).unwrap();
    let foreign = directory.path().join("foreign");
    std::fs::write(&foreign, b"synthetic foreign content").unwrap();
    symlink(&foreign, &state).unwrap();
    assert!(matches!(c.set_opt_in(true), Err(Error::State)));
    assert_eq!(
        std::fs::read(foreign).unwrap(),
        b"synthetic foreign content"
    );
}

#[test]
fn bounded_dimensions_and_context_do_not_cross_routes() {
    let directory = tempfile::tempdir().unwrap();
    let c = client(directory.path());
    c.set_opt_in(true).unwrap();
    assert!(
        c.record("rich", || [("format".into(), "private-path".into())].into())
            .is_err()
    );
    c.record("rich", values).unwrap();
    c.record("basic", Dimensions::new).unwrap();
    let mut nonce = String::new();
    c.schedule(|value| {
        nonce = value.into();
        Ok(())
    })
    .unwrap();
    c.deliver(&nonce, |body, token| {
        let value: serde_json::Value = serde_json::from_str(body).unwrap();
        if value["collection"] == "opt_out" {
            assert!(token.is_none());
            assert!(value.get("installation_id").is_none());
            assert!(value["rows"][0].get("system").is_none());
        } else { assert!(token.is_some()); }
        Some(serde_json::json!({"batch_id":value["batch_id"], "payload_sha256":hash(body.as_bytes())}).to_string())
    }).unwrap();
}

#[test]
fn withdrawal_invalidates_a_prepared_worker_and_no_late_send_occurs() {
    let directory = tempfile::tempdir().unwrap();
    let c = client(directory.path());
    c.set_opt_in(true).unwrap();
    c.record("rich", values).unwrap();
    let mut nonce = String::new();
    c.schedule(|value| {
        nonce = value.into();
        Ok(())
    })
    .unwrap();
    c.set_opt_in(false).unwrap();
    assert!(
        !c.deliver(&nonce, |_, _| panic!("withdrawal must cancel"))
            .unwrap()
    );
    assert_eq!(c.status().unwrap().queued_batches, 0);
}

#[test]
fn immutable_batch_survives_a_lost_ack_and_is_not_counted_again() {
    let directory = tempfile::tempdir().unwrap();
    let c = client(directory.path());
    c.record("basic", Dimensions::new).unwrap();
    let mut nonce = String::new();
    c.schedule(|value| {
        nonce = value.into();
        Ok(())
    })
    .unwrap();
    let mut first = String::new();
    assert!(
        !c.deliver(&nonce, |body, _| {
            first = body.into();
            None
        })
        .unwrap()
    );
    {
        let mut store = Store::open(&c, false).unwrap().unwrap();
        store.state.next_attempt = 0;
        store.save().unwrap();
    }
    c.schedule(|value| {
        nonce = value.into();
        Ok(())
    })
    .unwrap();
    assert!(c.deliver(&nonce, |body, _| {
        assert_eq!(body, first);
        let value: serde_json::Value = serde_json::from_str(body).unwrap();
        Some(serde_json::json!({"batch_id":value["batch_id"], "payload_sha256":hash(body.as_bytes())}).to_string())
    }).unwrap());
    assert_eq!(c.status().unwrap().queued_batches, 0);
}

fn resource_server(
    status: u16,
    body: &[u8],
    extra: &str,
) -> (String, std::thread::JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let body = body.to_vec();
    let extra = extra.to_owned();
    let handle = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(std::time::Duration::from_secs(2)))
            .unwrap();
        let mut request = Vec::new();
        let mut byte = [0];
        while !request.ends_with(b"\r\n\r\n") {
            socket.read_exact(&mut byte).unwrap();
            request.push(byte[0]);
        }
        write!(
            socket,
            "HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\n{extra}Connection: close\r\n\r\n",
            body.len()
        )
        .unwrap();
        socket.write_all(&body).unwrap();
        String::from_utf8(request).unwrap()
    });
    (origin, handle)
}

#[test]
fn download_is_verified_with_declined_reporting_and_sends_no_identifiers() {
    let directory = tempfile::tempdir().unwrap();
    let c = client(directory.path());
    c.set_opt_in(false).unwrap();
    let bytes = b"synthetic grammar";
    let (origin, server) = resource_server(200, bytes, "");
    let resource = Resource::new(
        "grammar.rust",
        &format!("{origin}/grammar"),
        bytes.len() as u64,
        &hash(bytes),
    )
    .unwrap()
    .reporting("rich", values());
    let mut result = c.download(&resource, &DownloadOptions::default()).unwrap();
    let mut stored = Vec::new();
    result.reader().unwrap().read_to_end(&mut stored).unwrap();
    assert_eq!(stored, bytes);
    assert_eq!(c.status().unwrap().open_dimensions, 0);
    let request = server.join().unwrap().to_lowercase();
    assert!(!request.contains("authorization"));
    assert!(!request.contains("installation"));
    assert!(!request.contains("project"));
}

#[test]
fn deletion_keeps_authority_until_a_contract_valid_completion() {
    for (status, body, extra, completed) in [
        (
            404,
            br#"{"error":{"code":"not_found"}}"#.as_slice(),
            "Cache-Control: no-store\r\n",
            false,
        ),
        (
            404,
            br#"{"error":{"code":"installation_not_found"}}"#.as_slice(),
            "Cache-Control: no-store\r\n",
            true,
        ),
        (204, b"".as_slice(), "", false),
        (204, b"".as_slice(), "Cache-Control: no-store\r\n", true),
    ] {
        let root = tempfile::tempdir().unwrap();
        let (origin, server) = resource_server(status, body, extra);
        let c = Client::new(&origin, root.path(), "fixture", "1.0.0", []).unwrap();
        c.set_opt_in(true).unwrap();
        c.delete().unwrap();
        let mut nonce = String::new();
        c.schedule(|value| {
            nonce = value.into();
            Ok(())
        })
        .unwrap();
        assert_eq!(c.run_background_worker(&nonce).unwrap(), completed);
        assert_eq!(c.status().unwrap().deletion_pending, !completed);
        server.join().unwrap();
    }
}

#[test]
fn integrity_redirect_offline_and_cancellation_fail_before_success_count() {
    let directory = tempfile::tempdir().unwrap();
    let c = client(directory.path());
    for (status, extra, expected) in [
        (200, "", "integrity"),
        (
            302,
            "Location: https://not-contacted.invalid/\r\n",
            "status",
        ),
    ] {
        let (origin, server) = resource_server(status, b"bad", extra);
        let resource = Resource::new("grammar.rust", &origin, 3, &hash(b"yes"))
            .unwrap()
            .reporting("basic", Dimensions::new());
        let result = c.download(&resource, &DownloadOptions::default());
        match expected {
            "integrity" => assert!(matches!(result, Err(Error::Integrity))),
            _ => assert!(matches!(result, Err(Error::HttpStatus(302)))),
        }
        server.join().unwrap();
    }
    let resource = Resource::new(
        "grammar.rust",
        "https://not-contacted.invalid/file",
        3,
        &hash(b"yes"),
    )
    .unwrap();
    let offline = client(directory.path()).with_policy(Policy {
        offline: true,
        ..Policy::default()
    });
    assert!(matches!(
        offline.download(&resource, &DownloadOptions::default()),
        Err(Error::Offline)
    ));
    let options = DownloadOptions::default();
    options.cancellation.cancel();
    assert!(matches!(
        c.download(&resource, &options),
        Err(Error::Cancelled)
    ));
    assert!(!c.directory.exists());
}
