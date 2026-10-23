//! Synthetic host: stdout and exit status belong to the command, guidance to the host.
use app_tracking::{Mode, Tool, UpdateClient};
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<_> = std::env::args().collect();
    let origin = args.get(1).expect("origin argument");
    let cache = args.get(2).expect("cache argument");
    let installed = args.get(3).map(String::as_str).unwrap_or("1.0.0");
    let mode = match args.get(4).map(String::as_str) {
        Some("disabled") => Mode::Disabled,
        Some("offline") => Mode::Offline,
        _ => Mode::Enabled,
    };
    let distribution = args.get(5).map(String::as_str).unwrap_or("npm");
    println!("{{\"command\":\"ok\"}}");
    let tool = Tool::new("dalo", installed, distribution, "stable").expect("host metadata");
    let client = UpdateClient::new(origin, cache, tool).expect("host configuration");
    if let Ok(Some(update)) = client.check(mode) {
        eprintln!(
            "Update available: dalo {}. Run: npm install -g getdalo",
            update.latest_version
        );
    }
    // Deliberately nonzero to prove that advisory update work leaves this unchanged.
    ExitCode::from(7)
}
