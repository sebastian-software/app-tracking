//! Synthetic integration fixture, not a CLI consent prompt. The harness alone
//! invokes `enable` after selecting synthetic consent; no real tool uses this.
use app_tracking::project::{Origin, RepositoryContext};
use app_tracking::telemetry::{Client, Control, Error, Invocation, Policy};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let result = (|| -> Result<(), Error> {
        let client = Client::new(&args[1], &args[2], "dalo")?;
        let action = args[3].as_str();
        let policy = Policy {
            offline: action == "count-only",
            ..Policy::default()
        };
        let control = match action {
            "enable" => Some(Control::Enable),
            "withdraw" => Some(Control::Withdraw),
            "delete" => Some(Control::Delete),
            "reset" => Some(Control::Reset),
            "forget" => Some(Control::ForgetUnverified),
            _ => None,
        };
        if let Some(control) = control {
            println!(
                "{}",
                serde_json::to_string(&client.control(control, &policy)?)
                    .map_err(|_| Error::State)?
            );
        } else if action == "preview" {
            println!("{}", client.preview(&policy)?);
        } else if action == "status" {
            println!(
                "{}",
                serde_json::to_string(&client.status(&policy)?).map_err(|_| Error::State)?
            );
        } else {
            let invocation =
                matches!(action, "record" | "ordinary" | "count-only").then_some(Invocation {
                    command: "sync",
                    tool_version: "1.10.0",
                });
            let result = client.run(
                &policy,
                invocation,
                || RepositoryContext {
                    origin: Origin::Present(
                        "git@github.com:example-org/example-project.git".into(),
                    ),
                    package_json: None,
                },
                action == "flush",
            )?;
            if action != "ordinary" {
                println!(
                    "{}",
                    serde_json::to_string(&result).map_err(|_| Error::State)?
                );
            }
        }
        Ok(())
    })();
    if args.get(3).map(String::as_str) == Some("ordinary") {
        println!("{{\"command\":\"ok\"}}");
        std::process::exit(7);
    }
    match result {
        Ok(()) => {}
        Err(Error::Busy) => println!("{{\"counted\":false,\"action\":\"busy\"}}"),
        Err(_) => {
            eprintln!("Synthetic telemetry client operation failed");
            std::process::exit(1);
        }
    }
}
