use super::super::{Client, Error, Store, hash};
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

// Run the actual worker in another process so the fixture exercises OS locks,
// the persisted handoff, HTTP, and acknowledgement rather than a lock mock.
#[test]
#[ignore = "subprocess fixture for the background worker tests"]
fn worker_process() {
    let Some(path) = std::env::var_os("APP_TRACKING_WORKER_TEST") else {
        return;
    };
    let config: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    let client = Client::registered(
        config["origin"].as_str().unwrap(),
        config["root"].as_str().unwrap(),
        "ferriki",
        "1.0.0",
    )
    .unwrap();
    std::fs::write(config["ready"].as_str().unwrap(), b"ready").unwrap();
    std::io::stdin().read_exact(&mut [0]).unwrap();
    let result = client.run_background_worker(config["nonce"].as_str().unwrap());
    let value = match result {
        Ok(accepted) => json!({"accepted": accepted}),
        Err(Error::Busy) => json!({"error": "Busy"}),
        Err(error) => panic!("unexpected worker error: {error}"),
    };
    std::fs::write(config["result"].as_str().unwrap(), value.to_string()).unwrap();
}

struct Worker {
    child: Child,
    result: PathBuf,
}

impl Worker {
    fn start(root: &Path, origin: &str, nonce: &str) -> Self {
        let config = root.join("worker-config.json");
        let ready = root.join("worker-ready");
        let result = root.join("worker-result.json");
        std::fs::write(
            &config,
            json!({"root": root, "origin": origin, "nonce": nonce,
                "ready": ready, "result": result})
            .to_string(),
        )
        .unwrap();
        let child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "client::worker::tests::worker_process",
                "--ignored",
                "--nocapture",
            ])
            .env("APP_TRACKING_WORKER_TEST", config)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let mut worker = Self { child, result };
        let deadline = Instant::now() + Duration::from_secs(5);
        while !ready.exists() {
            assert!(Instant::now() < deadline, "worker did not reach its entry");
            assert!(worker.child.try_wait().unwrap().is_none());
            std::thread::sleep(Duration::from_millis(1));
        }
        worker.child.stdin.take().unwrap().write_all(b"1").unwrap();
        worker
    }

    fn assert_waiting_for_state(&mut self) {
        // Observe the worker while the real lock is held, then release it well
        // within the bounded retry window. An immediate Busy exit is a failure.
        let deadline = Instant::now() + Duration::from_millis(10);
        while Instant::now() < deadline {
            assert!(
                self.child.try_wait().unwrap().is_none(),
                "worker abandoned a briefly held state lock"
            );
            std::thread::sleep(Duration::from_millis(1));
        }
    }

    fn finish(&mut self) -> Value {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                assert!(status.success());
                return serde_json::from_slice(&std::fs::read(&self.result).unwrap()).unwrap();
            }
            assert!(Instant::now() < deadline, "worker did not finish");
            std::thread::sleep(Duration::from_millis(1));
        }
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn prepare(root: &Path, origin: &str, deleting: bool) -> (Client, String) {
    let client = Client::registered(origin, root, "ferriki", "1.0.0").unwrap();
    client.set_opt_in(true).unwrap();
    if deleting {
        client.delete().unwrap();
    } else {
        client
            .record("language.use", || {
                [
                    ("language".into(), "rust".into()),
                    ("source".into(), "explicit".into()),
                ]
                .into()
            })
            .unwrap();
    }
    let mut nonce = String::new();
    assert!(
        client
            .schedule(|value| {
                nonce = value.into();
                Ok(())
            })
            .unwrap()
    );
    (client, nonce)
}

fn request(listener: &TcpListener) -> (TcpStream, String, String) {
    listener.set_nonblocking(true).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut socket = loop {
        match listener.accept() {
            Ok((socket, _)) => break socket,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                assert!(
                    Instant::now() < deadline,
                    "worker did not send its operation"
                );
                std::thread::sleep(Duration::from_millis(1));
            }
            Err(error) => panic!("fixture accept failed: {error}"),
        }
    };
    socket.set_nonblocking(false).unwrap();
    socket
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut headers = Vec::new();
    while !headers.ends_with(b"\r\n\r\n") {
        let mut byte = [0];
        socket.read_exact(&mut byte).unwrap();
        headers.push(byte[0]);
    }
    let headers = String::from_utf8(headers).unwrap();
    let length = headers
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().unwrap())
        })
        .unwrap_or(0);
    let mut body = vec![0; length];
    socket.read_exact(&mut body).unwrap();
    (socket, headers, String::from_utf8(body).unwrap())
}

#[test]
fn spawned_workers_retry_state_contention_before_upload_and_deletion() {
    for deleting in [false, true] {
        for at_acknowledgement in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let origin = format!("http://{}", listener.local_addr().unwrap());
            let (client, nonce) = prepare(root.path(), &origin, deleting);
            let initial =
                (!at_acknowledgement).then(|| Store::open(&client, false).unwrap().unwrap());
            let mut worker = Worker::start(root.path(), &origin, &nonce);
            if initial.is_some() {
                worker.assert_waiting_for_state();
                drop(initial);
            }
            let (mut socket, headers, body) = request(&listener);
            assert!(
                headers
                    .to_ascii_lowercase()
                    .contains("authorization: bearer ")
            );
            let response = if deleting {
                assert!(headers.starts_with("DELETE /v1/event-installations/"));
                String::new()
            } else {
                assert!(headers.starts_with("POST /v1/event-batches "));
                let batch: Value = serde_json::from_str(&body).unwrap();
                assert_eq!(batch["rows"][0]["count"], 1);
                json!({"batch_id": batch["batch_id"], "payload_sha256": hash(body.as_bytes())})
                    .to_string()
            };
            let acknowledgement =
                at_acknowledgement.then(|| Store::open(&client, false).unwrap().unwrap());
            let status = if deleting { 204 } else { 200 };
            write!(socket, "HTTP/1.1 {status} Fixture\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}", response.len()).unwrap();
            drop(socket);
            if acknowledgement.is_some() {
                worker.assert_waiting_for_state();
                drop(acknowledgement);
            }
            assert_eq!(worker.finish(), json!({"accepted": true}));
            let status = client.status().unwrap();
            assert_eq!(status.queued_batches, 0);
            assert!(!status.deletion_pending);
            assert!(!client.run_background_worker(&nonce).unwrap());
            assert_eq!(
                listener.accept().unwrap_err().kind(),
                std::io::ErrorKind::WouldBlock
            );
        }
    }
}

#[test]
fn prolonged_state_contention_leaves_the_handoff_pending() {
    for deleting in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let origin = "http://127.0.0.1:1";
        let (client, nonce) = prepare(root.path(), origin, deleting);
        let store = Store::open(&client, false).unwrap().unwrap();
        assert!(matches!(client.status(), Err(Error::Busy)));
        let mut worker = Worker::start(root.path(), origin, &nonce);
        assert_eq!(worker.finish(), json!({"error": "Busy"}));
        assert_eq!(store.state.job.as_ref().unwrap().nonce, nonce);
        assert_eq!(store.state.deleting, deleting);
    }
}
