//! Separate consent for screened monthly summaries; ordinary usage grants do not include it.
use super::{Client, Collection, Error, PermissionOutcome, Store, now};
use serde::{Deserialize, Serialize};
use std::io::IsTerminal;
use std::time::Duration;

pub const HISTORY_CONSENT_REVISION: &str = "monthly-history-v1";

/// The same disclosure is used by terminal dialogs and host settings commands.
pub const HISTORY_NOTICE: &str = "Sebastian Software GmbH uses monthly summaries to understand usage trends and plan product maintenance. Detailed reports remain limited to 90 days. With this separate permission, screened monthly counts and monthly installation/project totals may be retained for 24 months after the month ends. These are not counts of people or a guarantee of anonymity. Only reports from the UTC date after acknowledgement are eligible. This choice does not authorize public release or cross-tool profile linking. You can withdraw this permission separately in the tool's settings. Acknowledged withdrawal invalidates affected monthly summaries; offline changes remain pending. Declining does not limit the tool or update checks. Privacy and rights: https://sebastian-software.com/privacy#tool-usage-history (contact: info@sebastian-software.de).";

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct HistoryChoice {
    #[serde(default)]
    pub revision: String,
    pub enabled: bool,
    pub changed_at: u64,
    pub confirmed: bool,
}

#[derive(Debug, Serialize)]
pub struct HistoryPermissionStatus {
    pub decision: super::OptInDecision,
    /// The saved choice has not received an exact server acknowledgement.
    pub pending: bool,
}

impl Client {
    /// Save an explicit additional choice without network I/O. Historical
    /// processing starts only after `sync_history_permission` is acknowledged,
    /// from the following UTC date. This never grants ordinary usage reporting.
    pub fn set_history_opt_in(&self, enabled: bool) -> Result<(), Error> {
        let Some(mut store) = Store::open(self, !enabled)? else {
            return if enabled {
                Err(Error::AdditionalPermission)
            } else {
                Ok(())
            };
        };
        let _network = store.network_guard()?;
        if enabled && !self.allowed(&store.state, Collection::OptIn) {
            return Err(Error::AdditionalPermission);
        }
        let mut timestamp = now()?;
        if let Some(choice) = &store.state.history {
            if choice.enabled == enabled
                && (!enabled || choice.revision == HISTORY_CONSENT_REVISION)
                && (choice.confirmed || timestamp.saturating_sub(choice.changed_at) < 7_776_000_000)
            {
                return Ok(());
            }
            timestamp = timestamp.max(choice.changed_at.saturating_add(1));
        }
        if !enabled {
            store.state.withdraw_public_usage()?;
        }
        store.state.history = Some(HistoryChoice {
            revision: HISTORY_CONSENT_REVISION.into(),
            enabled,
            changed_at: timestamp,
            confirmed: store.state.identity.is_none(),
        });
        store.state.generation = store.state.generation.saturating_add(1);
        store.state.job = None;
        store.save()
    }

    /// Ask separately about 24-month monthly summaries. Saved refusals and
    /// confirmed grants are reused; CI, workers, JSON modes, and nonterminals
    /// never open a dialog. Neither this method nor construction sends data.
    pub fn request_history_opt_in(&self, reason: &str) -> Result<PermissionOutcome, Error> {
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
        if !self.allowed(&store.state, Collection::OptIn) || self.is_background_worker() {
            return Ok(PermissionOutcome::Unavailable);
        }
        if let Some(choice) = &store.state.history {
            if !choice.enabled {
                return Ok(PermissionOutcome::Declined);
            }
            if choice.revision == HISTORY_CONSENT_REVISION
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
            "\nOptional monthly summaries for {}\n\n{}\n\n{}\n\nAllow monthly summaries? [y/N] ",
            self.tool,
            reason.trim(),
            HISTORY_NOTICE
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
            || (enabled && store.state.generation != generation)
        {
            return Ok(PermissionOutcome::Unavailable);
        }
        if !enabled {
            store.state.withdraw_public_usage()?;
        }
        store.state.history = Some(HistoryChoice {
            revision: HISTORY_CONSENT_REVISION.into(),
            enabled,
            changed_at: now()?.max(
                store
                    .state
                    .history
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

    pub fn history_status(&self) -> Result<HistoryPermissionStatus, Error> {
        let store = Store::open(self, false)?;
        Ok(HistoryPermissionStatus {
            decision: super::OptInDecision::from(
                store
                    .as_ref()
                    .and_then(|s| s.state.history.as_ref())
                    .filter(|h| !h.enabled || h.revision == HISTORY_CONSENT_REVISION)
                    .map(|h| h.enabled),
            ),
            pending: store
                .as_ref()
                .is_some_and(|s| s.state.history.as_ref().is_some_and(|h| !h.confirmed)),
        })
    }

    /// Explicit settings-network operation, with a five-second total budget.
    /// Call from a consent/settings command, never the ordinary command path.
    /// Offline mode keeps the choice pending; identical retries keep its timestamp.
    pub fn sync_history_permission(&self) -> Result<bool, Error> {
        self.sync_history_with(|url, token, body| {
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

    fn sync_history_with(
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
        let Some(choice) = store.state.history.clone() else {
            return Ok(false);
        };
        if choice.enabled && choice.revision != HISTORY_CONSENT_REVISION {
            return Ok(false);
        }
        if choice.confirmed {
            return Ok(true);
        }
        if choice.enabled && !self.allowed(&store.state, Collection::OptIn) {
            return Ok(false);
        }
        let Some(identity) = store.state.identity.as_ref() else {
            return Ok(false);
        };
        let body=serde_json::json!({"schema_version":1,"revision":HISTORY_CONSENT_REVISION,"enabled":choice.enabled,"changed_at":choice.changed_at}).to_string();
        let Some(receipt) = send(
            &format!(
                "{}/v1/history-permissions/events/{}",
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
            || receipt.revision != HISTORY_CONSENT_REVISION
            || receipt.enabled != choice.enabled
            || receipt.changed_at != choice.changed_at
        {
            return Ok(false);
        }
        store.state.history.as_mut().ok_or(Error::State)?.confirmed = true;
        store.save()?;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::{Interaction, OptInDecision};
    #[test]
    fn missing_or_unknown_disclosure_revision_never_reuses_an_affirmative_choice() {
        let root = tempfile::tempdir().unwrap();
        let client = Client::registered("https://example.test", root.path(), "palamedes", "1.0.0")
            .unwrap()
            .with_interaction(super::super::Interaction::Never);
        client.set_opt_in(true).unwrap();
        client.set_history_opt_in(true).unwrap();
        {
            let mut store = Store::open(&client, false).unwrap().unwrap();
            store.state.history.as_mut().unwrap().revision.clear();
            store.state.history.as_mut().unwrap().confirmed = true;
            store.save().unwrap();
        }
        assert!(matches!(
            client.history_status().unwrap().decision,
            OptInDecision::Undecided
        ));
        assert_eq!(
            client.request_history_opt_in("Privacy settings.").unwrap(),
            PermissionOutcome::Unavailable
        );
        assert!(
            !client
                .sync_history_with(|_, _, _| panic!("unknown scope must not reach transport"))
                .unwrap()
        );
        client.set_history_opt_in(true).unwrap();
        assert!(client.history_status().unwrap().pending);
        assert!(
            client
                .sync_history_with(|_, _, body| Some(body.into()))
                .unwrap()
        );
        {
            let mut store = Store::open(&client, false).unwrap().unwrap();
            store.state.history.as_mut().unwrap().revision = "future-scope".into();
            store.save().unwrap();
        }
        client.set_history_opt_in(false).unwrap();
        assert!(
            client
                .sync_history_with(|_, _, body| Some(body.into()))
                .unwrap()
        );
        assert!(matches!(
            client.history_status().unwrap().decision,
            OptInDecision::Declined
        ));
    }

    #[test]
    fn old_grants_never_include_history_and_choices_need_exact_acknowledgements() {
        let root = tempfile::tempdir().unwrap();
        let client = Client::registered("https://example.test", root.path(), "ferriki", "1.0.0")
            .unwrap()
            .with_interaction(Interaction::Never);
        assert!(client.set_history_opt_in(true).is_err());
        assert!(!client.directory.exists());
        client.set_opt_in(true).unwrap();
        assert!(matches!(
            client.history_status().unwrap().decision,
            OptInDecision::Undecided
        ));
        assert_eq!(
            client
                .request_history_opt_in("Help preserve trends.")
                .unwrap(),
            PermissionOutcome::Unavailable
        );
        client.set_history_opt_in(true).unwrap();
        assert!(client.history_status().unwrap().pending);
        assert!(
            !client
                .sync_history_with(|_, _, body| {
                    let mut value: serde_json::Value = serde_json::from_str(body).unwrap();
                    value["changed_at"] = 0.into();
                    Some(value.to_string())
                })
                .unwrap()
        );
        assert!(client.history_status().unwrap().pending);
        assert!(
            client
                .sync_history_with(|url, token, body| {
                    assert!(url.contains("/v1/history-permissions/events/"));
                    assert!(!body.contains(token));
                    Some(body.into())
                })
                .unwrap()
        );
        assert!(!client.history_status().unwrap().pending);
        let client =
            Client::registered("https://example.test", root.path(), "ferriki", "1.0.1").unwrap();
        assert_eq!(
            client
                .request_history_opt_in("Help preserve trends.")
                .unwrap(),
            PermissionOutcome::Granted
        );
        client.set_history_opt_in(false).unwrap();
        assert!(client.history_status().unwrap().pending);
        assert_eq!(
            client
                .request_history_opt_in("Help preserve trends.")
                .unwrap(),
            PermissionOutcome::Declined
        );
        assert!(
            client
                .sync_history_with(|_, _, body| Some(body.into()))
                .unwrap()
        );
    }
    #[test]
    fn offline_defers_permission_network_and_usage_refusal_withdraws_the_additional_scope() {
        let root = tempfile::tempdir().unwrap();
        let client =
            Client::registered("https://example.test", root.path(), "ferriki", "1.0.0").unwrap();
        client.set_opt_in(true).unwrap();
        client.set_history_opt_in(true).unwrap();
        let offline = client.with_policy(crate::telemetry::Policy {
            offline: true,
            ..Default::default()
        });
        assert!(
            !offline
                .sync_history_with(|_, _, _| panic!("offline must not send"))
                .unwrap()
        );
        offline.set_opt_in(false).unwrap();
        assert!(matches!(
            offline.history_status().unwrap().decision,
            OptInDecision::Declined
        ));
        assert!(offline.history_status().unwrap().pending);
    }
    #[test]
    fn explicit_refusal_survives_a_later_ordinary_grant() {
        let root = tempfile::tempdir().unwrap();
        let client =
            Client::registered("https://example.test", root.path(), "ferriki", "1.0.0").unwrap();
        client.set_history_opt_in(false).unwrap();
        client.set_opt_in(true).unwrap();
        assert_eq!(
            client
                .request_history_opt_in("Help preserve trends.")
                .unwrap(),
            PermissionOutcome::Declined
        );
    }

    #[test]
    fn settings_transport_requires_no_store_and_preserves_the_choice_on_redirect() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        for (status, extra, accepted) in [
            (200, "Cache-Control: no-store\r\n", true),
            (200, "", false),
            (307, "Location: https://example.test/elsewhere\r\n", false),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let origin = format!("http://{}", listener.local_addr().unwrap());
            let root = tempfile::tempdir().unwrap();
            let client = Client::registered(&origin, root.path(), "ferriki", "1.0.0").unwrap();
            client.set_opt_in(true).unwrap();
            client.set_history_opt_in(true).unwrap();
            let server = std::thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut headers = Vec::new();
                let mut byte = [0];
                while !headers.ends_with(b"\r\n\r\n") {
                    socket.read_exact(&mut byte).unwrap();
                    headers.push(byte[0]);
                }
                let headers = String::from_utf8(headers).unwrap();
                assert!(headers.starts_with("PUT /v1/history-permissions/events/"));
                let lower = headers.to_ascii_lowercase();
                assert!(lower.contains("app-tracking-tool: ferriki"));
                assert!(lower.contains("authorization: bearer "));
                let length = lower
                    .lines()
                    .find_map(|line| line.strip_prefix("content-length: "))
                    .unwrap()
                    .parse::<usize>()
                    .unwrap();
                assert!(length <= 1024);
                let mut body = vec![0; length];
                socket.read_exact(&mut body).unwrap();
                write!(socket, "HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\n{extra}Connection: close\r\n\r\n", body.len()).unwrap();
                socket.write_all(&body).unwrap();
            });
            assert_eq!(client.sync_history_permission().unwrap(), accepted);
            assert_eq!(client.history_status().unwrap().pending, !accepted);
            server.join().unwrap();
        }
    }
}
