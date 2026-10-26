//! Synthetic process-lifetime fixture. Production hosts supply their own policy.
use app_tracking::project::{Origin, RepositoryContext};
use app_tracking::telemetry::{
    BACKGROUND_WORKER_ARGUMENT, Client, Control, Error, Invocation, Policy,
};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let worker = args
        .get(1)
        .is_some_and(|arg| arg == BACKGROUND_WORKER_ARGUMENT);
    let result = (|| -> Result<(), Error> {
        let client = Client::new(
            &std::env::var("APP_TRACKING_PROBE_ORIGIN").map_err(|_| Error::Configuration)?,
            std::env::var_os("APP_TRACKING_PROBE_STATE").ok_or(Error::Configuration)?,
            "palamedes",
        )?;
        let action = args.get(1).map(String::as_str).unwrap_or("");
        let policy = Policy {
            offline: action == "offline",
            ..Policy::default()
        };
        if worker {
            if args.len() != 3 {
                return Err(Error::Configuration);
            }
            client.run_background_worker(&policy, &args[2])?;
        } else if action == "enable" {
            client.control(Control::Enable, &policy)?;
        } else if action == "status" {
            println!(
                "{}",
                serde_json::to_string(&client.status(&policy)?).map_err(|_| Error::State)?
            );
        } else if action == "withdraw" {
            client.control(Control::Withdraw, &policy)?;
        } else {
            if action == "delete" {
                client.control(Control::Delete, &policy)?;
            }
            client.run_in_background(
                &policy,
                matches!(action, "ordinary" | "offline").then_some(Invocation {
                    command: "report",
                    tool_version: "2.0.0",
                }),
                || RepositoryContext {
                    origin: Origin::Unavailable,
                    package_json: None,
                },
                action == "flush",
            )?;
        }
        Ok(())
    })();
    if args.get(1).map(String::as_str) == Some("ordinary") {
        println!("{{\"command\":\"ok\"}}");
        std::process::exit(7);
    }
    if result.is_err() {
        if !worker {
            eprintln!("Synthetic background client operation failed");
        }
        std::process::exit(1);
    }
}
