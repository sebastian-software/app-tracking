//! Synthetic integration fixture. No production endpoint or user state default.
use app_tracking::client::{BACKGROUND_WORKER_ARGUMENT, Client, DownloadOptions, Resource};
use std::collections::BTreeMap;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let origin = std::env::var("APP_TRACKING_FIXTURE_ORIGIN")?;
    let root = std::env::var("APP_TRACKING_FIXTURE_ROOT")?;
    let client = Client::registered(&origin, root, "ferriki", "2.0.0")?;
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
        Some("download") => {
            let resource = Resource::new(
                "fixture.grammar",
                &format!("{origin}/fixture-resource"),
                17,
                "f4c7f98a64e35d2080ba3bce770bd94353d2fb7ee1e80320fcb119b250f56c8a",
            )?
            .reporting(
                "resource.download",
                BTreeMap::from([("kind".into(), "grammar".into())]),
            );
            let result = client.download(&resource, &DownloadOptions::default())?;
            assert_eq!(result.len(), 17);
        }
        Some("preview") => println!("{}", client.preview()?),
        _ => return Err("unknown fixture operation".into()),
    }
    Ok(())
}
