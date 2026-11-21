use super::*;
use crate::client::OptInDecision;
use crate::telemetry::CONSENT_REVISION;

fn reporting(path: &Path, policy: Policy) -> Client {
    Client::registered("https://tracking.example.com", path, "dalo", "1.0.0")
        .unwrap()
        .with_policy(policy)
}

fn command() -> Dimensions {
    [("command".into(), "status".into())].into()
}

#[test]
fn cli_counts_once_and_withdraws_without_touching_update_policy() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("private");
    let policy = Policy {
        offline: true,
        ..Policy::default()
    };
    let mut disabled = CliClient::new(reporting(&path, policy.clone()));
    assert_eq!(
        disabled
            .record_invocation("cli.invocation", command())
            .unwrap(),
        InvocationRecorded::Reporting(Recorded::Suppressed),
    );
    assert!(!path.exists());

    let client = reporting(&path, policy);
    client.set_opt_in(true).unwrap();
    let mut cli = CliClient::new(client);
    assert_eq!(
        cli.record_invocation("cli.invocation", command()).unwrap(),
        InvocationRecorded::Reporting(Recorded::Counted),
    );
    assert_eq!(
        cli.record_invocation("cli.invocation", command()).unwrap(),
        InvocationRecorded::AlreadyRecorded,
    );
    assert!(!cli.complete().unwrap());
    let preview: serde_json::Value = serde_json::from_str(&cli.preview().unwrap()).unwrap();
    assert_eq!(preview["open"][0]["count"], 1);
    assert_eq!(cli.withdraw_reporting().unwrap().open_dimensions, 0);
    let request = cli.delete_reporting().unwrap();
    assert!(request.status.deletion_pending);
    assert!(!request.handed_off.unwrap());
    let mut store = Store::open(&cli.reporting, false).unwrap().unwrap();
    store.state.next_attempt = 123;
    store.save().unwrap();
    drop(store);
    assert!(cli.delete_reporting().unwrap().status.deletion_pending);
    let store = Store::open(&cli.reporting, false).unwrap().unwrap();
    assert_eq!(store.state.next_attempt, 123);
}

#[test]
fn ci_uses_an_isolated_root_and_requires_explicit_authorization() {
    let dir = tempfile::tempdir().unwrap();
    let personal = dir.path().join("personal");
    let ci = tempfile::tempdir_in(dir.path()).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::{PermissionsExt, symlink};
        fs::set_permissions(ci.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let alias = dir.path().join("alias");
        symlink(ci.path(), &alias).unwrap();
        assert!(validate_ci_state_root(&alias.join(""), None).is_err());
    }
    assert!(validate_ci_state_root(dir.path(), Some(&personal)).is_err());
    assert!(validate_ci_state_root(Path::new("relative"), None).is_err());
    assert_eq!(
        validate_ci_state_root(ci.path(), Some(&personal)).unwrap(),
        fs::canonicalize(ci.path()).unwrap(),
    );
    let policy = Policy {
        ci: true,
        ci_revision: Some(CONSENT_REVISION.into()),
        isolated_ci_state: true,
        offline: true,
        ..Policy::default()
    };
    let mut cli = CliClient::new(reporting(ci.path(), policy));
    assert_eq!(
        cli.record_invocation("cli.invocation", command()).unwrap(),
        InvocationRecorded::Reporting(Recorded::Suppressed),
    );
    assert_eq!(
        cli.enable_ci_reporting().unwrap().decision,
        OptInDecision::Granted
    );
    let local = CliClient::new(reporting(&personal, Policy::default()));
    assert!(local.enable_ci_reporting().is_err());
    assert!(!personal.exists());
}

#[test]
fn shared_environment_applies_only_restrictions() {
    let policy = resolve_policy(
        Policy {
            telemetry: Some("off".into()),
            ..Policy::default()
        },
        |key| match key {
            "APP_TRACKING_TELEMETRY" => Some("on".into()),
            "APP_TRACKING_CONSENT" => Some(CONSENT_REVISION.into()),
            "APP_TRACKING_CI" => Some(CONSENT_REVISION.into()),
            "CI" => Some("1".into()),
            "DO_NOT_TRACK" => Some("0".into()),
            _ => None,
        },
    );
    assert_eq!(policy.telemetry.as_deref(), Some("off"));
    assert!(!policy.do_not_track);
    assert!(policy.ci);
    assert!(!policy.isolated_ci_state);
    assert!(policy.environment_consent.is_none());
}

#[test]
fn worker_factory_is_only_called_for_the_reserved_entry() {
    assert!(handle_worker([OsString::from("status")], || panic!("unexpected client")).is_none());
    assert!(matches!(
        handle_worker([OsString::from(BACKGROUND_WORKER_ARGUMENT)], || panic!(
            "missing nonce"
        )),
        Some(Err(Error::Background)),
    ));
    let temp = tempfile::tempdir().unwrap();
    assert!(matches!(
        handle_worker(
            [BACKGROUND_WORKER_ARGUMENT.into(), "invalid".into()],
            || {
                Ok(reporting(
                    temp.path(),
                    Policy {
                        offline: true,
                        ..Policy::default()
                    },
                ))
            }
        ),
        Some(Err(Error::Configuration)),
    ));
}
