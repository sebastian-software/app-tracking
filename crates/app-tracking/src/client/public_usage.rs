//! Independent consent for public monthly totals; never inferred from private history.
use super::{Client, Collection, Error, PermissionOutcome, Store, now};
use serde::{Deserialize, Serialize};
use std::io::IsTerminal;
use std::time::Duration;

pub const PUBLIC_USAGE_CONSENT_REVISION: &str = "public-usage-v1";

/// The same disclosure is used by terminal dialogs and host settings commands.
pub const PUBLIC_USAGE_NOTICE: &str = "Sebastian Software GmbH would like to publish monthly usage totals so that users can understand adoption of our tools. This separate choice requires monthly-history permission. Only future reports from the UTC date after acknowledgement can contribute. Published figures contain month, tool, reporting stream, metric, local/CI context, and counts rounded down to tens, for up to 24 months after month end. They contain no installation/profile/repository identifiers, unique counts, or command/version/system breakdowns. Each published group needs at least 20 installations and 20 known repositories; no installation or repository may contribute more than 10 percent. These checks reduce disclosure risks but do not guarantee anonymity or prevent someone combining figures with other knowledge. Anyone can download and copy public figures, including through oss-metrics. You can withdraw this permission separately: after acknowledgement we remove affected published summaries, but cannot recall copies held by others. Offline withdrawal remains pending. Declining does not limit the tool, update checks, ordinary reporting, or internal monthly summaries. Privacy and rights: https://sebastian-software.com/privacy#tool-usage-public (contact: info@sebastian-software.de).";

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct PublicUsageChoice {
    #[serde(default)]
    pub revision: String,
    pub enabled: bool,
    pub changed_at: u64,
    pub confirmed: bool,
}

#[derive(Debug, Serialize)]
pub struct PublicUsagePermissionStatus {
    pub decision: super::OptInDecision,
    /// The saved choice has not received an exact server acknowledgement.
    pub pending: bool,
}

impl Client {
    fn history_status_unlocked(&self, state: &super::State) -> super::OptInDecision {
        super::OptInDecision::from(
            state
                .history
                .as_ref()
                .filter(|h| !h.enabled || h.revision == super::HISTORY_CONSENT_REVISION)
                .map(|h| h.enabled),
        )
    }

    /// Save an explicit additional choice without network I/O. Historical
    /// processing starts only after `sync_public_usage_permission` is acknowledged,
    /// from the following UTC date. This never grants ordinary usage reporting.
    pub fn set_public_usage_opt_in(&self, enabled: bool) -> Result<(), Error> {
        let Some(mut store) = Store::open(self, !enabled)? else {
            return if enabled {
                Err(Error::AdditionalPermission)
            } else {
                Ok(())
            };
        };
        let _network = store.network_guard()?;
        if enabled
            && (!self.allowed(&store.state, Collection::OptIn)
                || !matches!(
                    self.history_status_unlocked(&store.state),
                    super::OptInDecision::Granted
                ))
        {
            return Err(Error::AdditionalPermission);
        }
        let mut timestamp = now()?;
        if let Some(choice) = &store.state.public_usage {
            if choice.enabled == enabled
                && (!enabled || choice.revision == PUBLIC_USAGE_CONSENT_REVISION)
                && (choice.confirmed || timestamp.saturating_sub(choice.changed_at) < 7_776_000_000)
            {
                return Ok(());
            }
            timestamp = timestamp.max(choice.changed_at.saturating_add(1));
        }
        store.state.public_usage = Some(PublicUsageChoice {
            revision: PUBLIC_USAGE_CONSENT_REVISION.into(),
            enabled,
            changed_at: timestamp,
            confirmed: store.state.identity.is_none(),
        });
        store.state.generation = store.state.generation.saturating_add(1);
        store.state.job = None;
        store.save()
    }

    /// Ask separately about publicly accessible monthly usage totals. Saved refusals and
    /// confirmed grants are reused; CI, workers, JSON modes, and nonterminals
    /// never open a dialog. Neither this method nor construction sends data.
    pub fn request_public_usage_opt_in(&self, reason: &str) -> Result<PermissionOutcome, Error> {
        if reason.trim().is_empty()
            || reason.len() > 4096
            || reason
                .chars()
                .any(|c| c.is_control() && c != '\n' && c != '\t')
        {
            return Err(Error::Configuration);
        }
        let Some(store) = Store::open(self, false)? else {
            return Ok(PermissionOutcome::Unavailable);
        };
        if !self.allowed(&store.state, Collection::OptIn)
            || !matches!(
                self.history_status_unlocked(&store.state),
                super::OptInDecision::Granted
            )
            || self.is_background_worker()
        {
            return Ok(PermissionOutcome::Unavailable);
        }
        if let Some(choice) = &store.state.public_usage {
            if !choice.enabled {
                return Ok(PermissionOutcome::Declined);
            }
            if choice.revision == PUBLIC_USAGE_CONSENT_REVISION
                && (choice.confirmed || now()?.saturating_sub(choice.changed_at) < 7_776_000_000)
            {
                return Ok(PermissionOutcome::Granted);
            }
        }
        let generation = store.state.generation;
        drop(store);
        if self.policy.ci
            || self.interaction != super::Interaction::Terminal
            || !std::io::stdin().is_terminal()
            || !std::io::stderr().is_terminal()
        {
            return Ok(PermissionOutcome::Unavailable);
        }
        let prompt = format!(
            "\nOptional public usage totals for {}\n\n{}\n\n{}\n\nAllow public usage totals? [y/N] ",
            self.tool,
            reason.trim(),
            PUBLIC_USAGE_NOTICE
        );
        let Some(enabled) = super::permission::ask(
            &mut std::io::stdin().lock(),
            &mut std::io::stderr().lock(),
            &prompt,
        )?
        else {
            return Ok(PermissionOutcome::Unavailable);
        };
        let Some(mut store) = Store::open(self, false)? else {
            return Ok(PermissionOutcome::Unavailable);
        };
        let _network = store.network_guard()?;
        if !self.allowed(&store.state, Collection::OptIn)
            || (enabled
                && (store.state.generation != generation
                    || !matches!(
                        self.history_status_unlocked(&store.state),
                        super::OptInDecision::Granted
                    )))
        {
            return Ok(PermissionOutcome::Unavailable);
        }
        store.state.public_usage = Some(PublicUsageChoice {
            revision: PUBLIC_USAGE_CONSENT_REVISION.into(),
            enabled,
            changed_at: now()?.max(
                store
                    .state
                    .public_usage
                    .as_ref()
                    .map_or(0, |h| h.changed_at.saturating_add(1)),
            ),
            confirmed: false,
        });
        store.state.generation = store.state.generation.saturating_add(1);
        store.state.job = None;
        store.save()?;
        Ok(if enabled {
            PermissionOutcome::Granted
        } else {
            PermissionOutcome::Declined
        })
    }

    pub fn public_usage_status(&self) -> Result<PublicUsagePermissionStatus, Error> {
        let store = Store::open(self, false)?;
        Ok(PublicUsagePermissionStatus {
            decision: super::OptInDecision::from(
                store
                    .as_ref()
                    .and_then(|s| s.state.public_usage.as_ref())
                    .filter(|h| !h.enabled || h.revision == PUBLIC_USAGE_CONSENT_REVISION)
                    .map(|h| h.enabled),
            ),
            pending: store
                .as_ref()
                .is_some_and(|s| s.state.public_usage.as_ref().is_some_and(|h| !h.confirmed)),
        })
    }

    /// Explicit settings-network operation, with a five-second total budget.
    /// Call from a consent/settings command, never the ordinary command path.
    /// Offline mode keeps the choice pending; identical retries keep its timestamp.
    pub fn sync_public_usage_permission(&self) -> Result<bool, Error> {
        self.sync_public_usage_with(|url, token, body| {
            let agent: ureq::Agent = ureq::Agent::config_builder()
                .timeout_global(Some(Duration::from_secs(5)))
                .max_redirects(0)
                .max_response_header_size(16_384)
                .http_status_as_error(false)
                .build()
                .into();
            let Ok(mut response) = agent
                .put(url)
                .header("Authorization", format!("Bearer {token}"))
                .header("App-Tracking-Tool", &self.tool)
                .header("Content-Type", "application/json")
                .send(body.as_bytes())
            else {
                return None;
            };
            if response.status().as_u16() != 200
                || response
                    .headers()
                    .get("cache-control")
                    .is_none_or(|v| v != "no-store")
            {
                return None;
            }
            response
                .body_mut()
                .with_config()
                .limit(2048)
                .read_to_string()
                .ok()
        })
    }

    fn sync_public_usage_with(
        &self,
        send: impl FnOnce(&str, &str, &str) -> Option<String>,
    ) -> Result<bool, Error> {
        if self.policy.offline {
            return Ok(false);
        }
        let Some(mut store) = Store::open(self, false)? else {
            return Ok(false);
        };
        let _network = store.network_guard()?;
        let Some(choice) = store.state.public_usage.clone() else {
            return Ok(false);
        };
        if choice.enabled && choice.revision != PUBLIC_USAGE_CONSENT_REVISION {
            return Ok(false);
        }
        if choice.confirmed {
            return Ok(true);
        }
        if choice.enabled
            && (!self.allowed(&store.state, Collection::OptIn)
                || !matches!(
                    self.history_status_unlocked(&store.state),
                    super::OptInDecision::Granted
                ))
        {
            return Ok(false);
        }
        let Some(identity) = store.state.identity.as_ref() else {
            return Ok(false);
        };
        let body=serde_json::json!({"schema_version":1,"revision":PUBLIC_USAGE_CONSENT_REVISION,"enabled":choice.enabled,"changed_at":choice.changed_at}).to_string();
        let Some(receipt) = send(
            &format!(
                "{}/v1/public-permissions/events/{}",
                self.origin, identity.id
            ),
            &identity.token,
            &body,
        ) else {
            return Ok(false);
        };
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Receipt {
            schema_version: u8,
            revision: String,
            enabled: bool,
            changed_at: u64,
        }
        let Ok(receipt) = serde_json::from_str::<Receipt>(&receipt) else {
            return Ok(false);
        };
        if receipt.schema_version != 1
            || receipt.revision != PUBLIC_USAGE_CONSENT_REVISION
            || receipt.enabled != choice.enabled
            || receipt.changed_at != choice.changed_at
        {
            return Ok(false);
        }
        store
            .state
            .public_usage
            .as_mut()
            .ok_or(Error::State)?
            .confirmed = true;
        store.save()?;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::{Interaction, OptInDecision};
    #[test]
    fn public_scope_requires_its_own_choice_and_both_prerequisites() {
        let root = tempfile::tempdir().unwrap();
        let client = Client::registered("https://example.test", root.path(), "palamedes", "1.0.0")
            .unwrap()
            .with_interaction(Interaction::Never);
        assert!(client.set_public_usage_opt_in(true).is_err());
        client.set_opt_in(true).unwrap();
        assert!(client.set_public_usage_opt_in(true).is_err());
        client.set_history_opt_in(true).unwrap();
        assert!(matches!(
            client.public_usage_status().unwrap().decision,
            OptInDecision::Undecided
        ));
        assert_eq!(
            client
                .request_public_usage_opt_in("Public settings.")
                .unwrap(),
            PermissionOutcome::Unavailable
        );
        client.set_public_usage_opt_in(true).unwrap();
        assert!(client.public_usage_status().unwrap().pending);
        assert!(
            !client
                .sync_public_usage_with(|_, _, _| Some("{}".into()))
                .unwrap()
        );
        assert!(
            client
                .sync_public_usage_with(|url, token, body| {
                    assert!(url.contains("/v1/public-permissions/events/"));
                    assert!(!body.contains(token));
                    Some(body.into())
                })
                .unwrap()
        );
        client.set_history_opt_in(false).unwrap();
        assert!(matches!(
            client.public_usage_status().unwrap().decision,
            OptInDecision::Declined
        ));
        assert!(client.public_usage_status().unwrap().pending);
        assert!(
            client
                .sync_public_usage_with(|_, _, body| Some(body.into()))
                .unwrap()
        );
        client.set_history_opt_in(true).unwrap();
        assert!(matches!(
            client.public_usage_status().unwrap().decision,
            OptInDecision::Declined
        ));
    }
    #[test]
    fn unknown_public_scope_and_offline_changes_never_reach_transport() {
        let root = tempfile::tempdir().unwrap();
        let client =
            Client::registered("https://example.test", root.path(), "palamedes", "1.0.0").unwrap();
        client.set_opt_in(true).unwrap();
        client.set_history_opt_in(true).unwrap();
        client.set_public_usage_opt_in(true).unwrap();
        {
            let mut store = Store::open(&client, false).unwrap().unwrap();
            store.state.public_usage.as_mut().unwrap().revision = "future-scope".into();
            store.save().unwrap();
        }
        assert!(
            !client
                .sync_public_usage_with(|_, _, _| panic!("unknown scope"))
                .unwrap()
        );
        let client = client.with_policy(crate::telemetry::Policy {
            offline: true,
            ..Default::default()
        });
        client.set_public_usage_opt_in(false).unwrap();
        assert!(
            !client
                .sync_public_usage_with(|_, _, _| panic!("offline"))
                .unwrap()
        );
        assert!(client.public_usage_status().unwrap().pending);
    }
}
