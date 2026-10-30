//! Equivalent Rust composition. The host owns flags, observation boundaries, and output.
//! Configuration comes from explicit synthetic-example environment variables.
use app_tracking::client::{BACKGROUND_WORKER_ARGUMENT, Client, Interaction};
use app_tracking::telemetry::Policy;
use app_tracking::{Mode, Tool, UpdateClient};
use std::process::ExitCode;

fn enabled(name: &str) -> bool {
    std::env::var(name).is_ok_and(|v| !matches!(v.as_str(), "" | "0" | "false"))
}

fn main() -> Result<ExitCode, Box<dyn std::error::Error>> {
    let origin = std::env::var("APP_TRACKING_EXAMPLE_ORIGIN")?;
    let root = std::env::var("APP_TRACKING_EXAMPLE_STATE")?;
    let cache = std::env::var("APP_TRACKING_EXAMPLE_CACHE")?;
    // Product-specific flags and isolation checks still belong to the host.
    let policy = Policy {
        do_not_track: enabled("DO_NOT_TRACK"),
        telemetry: std::env::var("APP_TRACKING_TELEMETRY").ok(),
        ci: enabled("CI") || enabled("CONTINUOUS_INTEGRATION"),
        ci_revision: std::env::var("APP_TRACKING_CI").ok(),
        isolated_ci_state: enabled("APP_TRACKING_EXAMPLE_ISOLATED_CI_STATE"),
        offline: enabled("APP_TRACKING_EXAMPLE_OFFLINE"),
        ..Default::default()
    };
    let mode = if policy.offline {
        Mode::Offline
    } else {
        Mode::Enabled
    };
    let reporting = Client::registered(&origin, root, "ardo", "1.0.0")?
        .with_policy(policy)
        .with_interaction(Interaction::Never);
    let updates = UpdateClient::new(
        &origin,
        cache,
        Tool::new("ardo", "1.0.0", "github", "stable")?,
    )?
    .with_service_metrics(false);
    let args: Vec<_> = std::env::args().collect();
    let action = args.get(1).map(String::as_str).unwrap_or("help");
    match action {
        BACKGROUND_WORKER_ARGUMENT => {
            reporting.run_background_worker(args.get(2).ok_or("missing worker nonce")?)?;
        }
        "status" => println!("{}", serde_json::to_string(&reporting.status()?)?),
        "preview" => println!("{}", reporting.preview()?),
        "permission" => {
            reporting.request_opt_in(
                "Help prioritize Ardo maintenance. Privacy: https://example.com/privacy",
            )?;
        }
        "withdraw" => {
            reporting.set_opt_in(false)?;
        }
        "disable" => {
            reporting.set_disabled(true)?;
        }
        "delete" => {
            reporting.delete()?;
            reporting.flush_in_background()?;
        }
        "build" => {
            // One host-owned observation; watch iterations and wrappers do not repeat it.
            let _ = reporting.record("cli.invocation", || {
                [("command".into(), "build".into())].into()
            });
            println!("{{\"command\":\"ok\"}}");
            // A synchronous bounded check: there is no in-flight Rust update task to cancel.
            if let Ok(Some(update)) = updates.check(mode) {
                eprintln!(
                    "Update {}; see {}",
                    update.latest_version, update.release_url
                );
            }
            let _ = reporting.flush_in_background(); // Local handoff; never await delivery.
            return Ok(ExitCode::from(7));
        }
        _ => println!(
            "Synthetic help: build, status, preview, permission, withdraw, disable, delete"
        ),
    }
    Ok(ExitCode::SUCCESS)
}
