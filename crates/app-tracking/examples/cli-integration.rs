//! Equivalent Rust composition. The host owns flags, observation boundaries, and output.
//! Configuration comes from explicit synthetic-example environment variables.
use app_tracking::cli::{CliClient, handle_worker, policy_from_environment};
use app_tracking::client::{Client, Interaction};
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
    let policy = policy_from_environment(Policy {
        offline: enabled("APP_TRACKING_EXAMPLE_OFFLINE"),
        ..Policy::default()
    });
    let mode = if policy.offline {
        Mode::Offline
    } else {
        Mode::Enabled
    };
    let reporting = || {
        Ok(Client::registered(&origin, &root, "ardo", "1.0.0")?
            .with_policy(policy.clone())
            .with_interaction(Interaction::Never))
    };
    if let Some(result) = handle_worker(std::env::args_os().skip(1), reporting) {
        result?;
        return Ok(ExitCode::SUCCESS);
    }
    let mut reporting = CliClient::new(reporting()?);
    let updates = UpdateClient::new(
        &origin,
        cache,
        Tool::new("ardo", "1.0.0", "github", "stable")?,
    )?
    .with_service_metrics(false);
    let args: Vec<_> = std::env::args().collect();
    let action = args.get(1).map(String::as_str).unwrap_or("help");
    match action {
        "status" => println!("{}", serde_json::to_string(&reporting.status()?)?),
        "preview" => println!("{}", reporting.preview()?),
        "permission" => {
            reporting.request_reporting_opt_in_in_settings(
                "Help prioritize Ardo maintenance. Privacy: https://example.com/privacy",
            )?;
        }
        "withdraw" => {
            reporting.withdraw_reporting()?;
        }
        "disable" => {
            reporting.disable_reporting()?;
        }
        "delete" => {
            let request = reporting.delete_reporting()?;
            request.handed_off?;
        }
        "build" => {
            // One host-owned observation; watch iterations and wrappers do not repeat it.
            let _ = reporting.record_invocation(
                "cli.invocation",
                [("command".into(), "build".into())].into(),
            );
            println!("{{\"command\":\"ok\"}}");
            // A synchronous bounded check: there is no in-flight Rust update task to cancel.
            if let Ok(Some(update)) = updates.check(mode) {
                eprintln!(
                    "Update {}; see {}",
                    update.latest_version, update.release_url
                );
            }
            let _ = reporting.complete(); // Local handoff; never await delivery.
            return Ok(ExitCode::from(7));
        }
        _ => println!(
            "Synthetic help: build, status, preview, permission, withdraw, disable, delete"
        ),
    }
    Ok(ExitCode::SUCCESS)
}
