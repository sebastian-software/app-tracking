//! Synthetic integration fixture. No production endpoint or user state default.
use app_tracking::client::{BACKGROUND_WORKER_ARGUMENT, Client, DownloadOptions, Resource};
use std::collections::BTreeMap;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let origin = std::env::var("APP_TRACKING_FIXTURE_ORIGIN")?;
    let root = std::env::var("APP_TRACKING_FIXTURE_ROOT")?;
    let client = Client::registered(&origin, root, "ferriki", "0.0.0-app-tracking-probe")?;
    let client = if std::env::var("APP_TRACKING_FIXTURE_CI").as_deref() == Ok("1") {
        client.with_policy(app_tracking::telemetry::Policy {
            ci: true,
            isolated_ci_state: true,
            ci_revision: Some(app_tracking::telemetry::CONSENT_REVISION.into()),
            ..Default::default()
        })
    } else {
        client
    };
    let arguments: Vec<_> = std::env::args().collect();
    match arguments.get(1).map(String::as_str) {
        Some(BACKGROUND_WORKER_ARGUMENT) => {
            let token = arguments.get(2).ok_or("missing worker token")?;
            let _ = client.run_background_worker(token)?;
        }
        Some("enable") => client.set_opt_in(true)?,
        Some("permission") => println!(
            "{:?}",
            client.request_opt_in("Help improve the synthetic fixture's resource support.")?
        ),
        Some("permission-reminder") => println!(
            "{:?}",
            client.request_opt_in_reminder(
                "Help improve the synthetic fixture's resource support."
            )?
        ),
        Some("baseline") => client.set_opt_in(false)?,
        Some("delete") => {
            client.delete()?;
            client.flush_in_background()?;
        }
        Some("record") => {
            client.record("language.use", || {
                BTreeMap::from([
                    ("language".into(), "rust".into()),
                    ("source".into(), "explicit".into()),
                ])
            })?;
            client.flush_in_background()?;
        }
        Some("flush") => {
            client.flush_in_background()?;
        }
        Some("exercise") => {
            client.record("language.use", || {
                BTreeMap::from([
                    ("language".into(), "rust".into()),
                    ("source".into(), "explicit".into()),
                ])
            })?;
            download(&client, &origin)?;
        }
        Some("download") => download(&client, &origin)?,
        Some("preview") => println!("{}", client.preview()?),
        _ => return Err("unknown fixture operation".into()),
    }
    Ok(())
}

fn download(client: &Client, origin: &str) -> Result<(), Box<dyn std::error::Error>> {
    let url = std::env::var("APP_TRACKING_FIXTURE_RESOURCE_URL")
        .unwrap_or_else(|_| format!("{origin}/fixture-resource"));
    let bytes: u64 = std::env::var("APP_TRACKING_FIXTURE_RESOURCE_BYTES")
        .unwrap_or_else(|_| "17".into())
        .parse()?;
    let digest = std::env::var("APP_TRACKING_FIXTURE_RESOURCE_SHA256").unwrap_or_else(|_| {
        "f4c7f98a64e35d2080ba3bce770bd94353d2fb7ee1e80320fcb119b250f56c8a".into()
    });
    let resource = Resource::new("fixture.grammar", &url, bytes, &digest)?.reporting(
        "resource.download",
        BTreeMap::from([("kind".into(), "grammar".into())]),
    );
    let result = client.download(&resource, &DownloadOptions::default())?;
    assert_eq!(result.len(), bytes);
    Ok(())
}
