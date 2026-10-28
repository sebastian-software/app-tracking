use super::{Client, Collection, Error, Store, hash, now, random, state::Job};
use serde::Deserialize;
use std::time::Duration;

pub const BACKGROUND_WORKER_ARGUMENT: &str = "--app-tracking-events-worker-v1";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    batch_id: String,
    payload_sha256: String,
}

impl Client {
    /// Persist a bounded delivery claim and launch this executable once. Hosts
    /// intercept BACKGROUND_WORKER_ARGUMENT before parsing ordinary arguments.
    /// No network or child wait occurs in the calling process.
    pub fn flush_in_background(&self) -> Result<bool, Error> {
        self.schedule(|nonce| {
            crate::telemetry::background::spawn_worker(nonce, BACKGROUND_WORKER_ARGUMENT)
                .map_err(|_| Error::Background)
        })
    }

    pub(super) fn schedule(
        &self,
        launch: impl FnOnce(&str) -> Result<(), Error>,
    ) -> Result<bool, Error> {
        if self.policy.offline {
            return Ok(false);
        }
        let Some(mut store) = Store::open(self, false)? else {
            return Ok(false);
        };
        let network = store.network_guard()?;
        let timestamp = now()?;
        store.state.prune(timestamp / 86_400_000);
        if timestamp < store.state.next_attempt {
            return Ok(false);
        }
        if store.state.deleting {
            let nonce = random()?;
            store.state.job = Some(Job {
                nonce: nonce.clone(),
                generation: store.state.generation,
                created: timestamp,
                batch: "delete".into(),
            });
            store.state.next_attempt = timestamp.saturating_add(60_000);
            store.save()?;
            drop(network);
            drop(store);
            launch(&nonce)?;
            return Ok(true);
        }
        if self.veto() || store.state.disabled {
            store.state.clear();
            store.save()?;
            return Ok(false);
        }
        if !self.allowed(&store.state, Collection::OptIn) {
            store.state.retain(Collection::OptOut);
        }
        if store.state.batches.is_empty() {
            store.state.close(self)?;
        }
        let Some(batch) = store.state.batches.first() else {
            store.save()?;
            return Ok(false);
        };
        let nonce = random()?;
        store.state.job = Some(Job {
            nonce: nonce.clone(),
            generation: store.state.generation,
            created: timestamp,
            batch: batch.id.clone(),
        });
        store.state.next_attempt = timestamp.saturating_add(60_000);
        store.save()?;
        drop(network);
        drop(store);
        launch(&nonce)?;
        Ok(true)
    }

    /// Consume one authenticated local handoff. Duplicate/stale workers make no
    /// request; the worker rechecks the persisted choice before network I/O.
    pub fn run_background_worker(&self, nonce: &str) -> Result<bool, Error> {
        if self.deliver_deletion(nonce)? {
            return Ok(true);
        }
        self.deliver(nonce, |body, token| {
            let agent: ureq::Agent = ureq::Agent::config_builder()
                .timeout_global(Some(Duration::from_secs(5)))
                .max_redirects(0)
                .max_response_header_size(16_384)
                .http_status_as_error(false)
                .user_agent("app-tracking-events-client")
                .build()
                .into();
            let mut request = agent
                .post(format!("{}/v1/event-batches", self.origin))
                .header("Content-Type", "application/json")
                .header("Accept", "application/json");
            if let Some(token) = token {
                request = request.header("Authorization", format!("Bearer {token}"));
            }
            let Ok(mut response) = request.send(body.as_bytes()) else {
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

    fn deliver_deletion(&self, nonce: &str) -> Result<bool, Error> {
        if self.policy.offline {
            return Ok(false);
        }
        let Some(mut store) = Store::open(self, false)? else {
            return Ok(false);
        };
        let _network = store.network_guard()?;
        let Some(job) = &store.state.job else {
            return Ok(false);
        };
        if job.nonce != nonce || job.batch != "delete" {
            return Ok(false);
        }
        let timestamp = now()?;
        let valid = job.generation == store.state.generation
            && timestamp >= job.created
            && timestamp - job.created <= 30_000
            && store.state.deleting;
        store.state.job = None;
        store.save()?;
        if !valid {
            return Ok(false);
        }
        let identity = store.state.identity.as_ref().ok_or(Error::State)?.clone();
        drop(store);
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(5)))
            .max_redirects(0)
            .max_response_header_size(16_384)
            .http_status_as_error(false)
            .build()
            .into();
        let response = agent
            .delete(format!(
                "{}/v1/event-installations/{}",
                self.origin, identity.id
            ))
            .header("Authorization", format!("Bearer {}", identity.token))
            .header("App-Tracking-Tool", &self.tool)
            .call();
        let mut store = Store::open(self, false)?.ok_or(Error::State)?;
        let complete = response.is_ok_and(|mut r| {
            if r.headers()
                .get("cache-control")
                .is_none_or(|value| value != "no-store")
            {
                return false;
            }
            if r.status().as_u16() == 204 {
                return r
                    .body_mut()
                    .with_config()
                    .limit(1)
                    .read_to_vec()
                    .is_ok_and(|body| body.is_empty());
            }
            if r.status().as_u16() != 404 {
                return false;
            }
            r.body_mut()
                .with_config()
                .limit(2048)
                .read_to_string()
                .ok()
                .and_then(|body| serde_json::from_str::<serde_json::Value>(&body).ok())
                .is_some_and(|value| value["error"]["code"] == "installation_not_found")
        });
        if complete {
            store.state.identity = None;
            store.state.deleting = false;
            if let Some(profile) = &mut store.state.profile {
                profile.enabled = false;
                profile.profile_id = None;
                profile.confirmed = true;
            }
            if let Some(history) = &mut store.state.history {
                history.enabled = false;
                history.confirmed = true;
            }
        }
        store.save()?;
        Ok(complete)
    }

    pub(super) fn deliver(
        &self,
        nonce: &str,
        send: impl FnOnce(&str, Option<&str>) -> Option<String>,
    ) -> Result<bool, Error> {
        if nonce.len() != 64
            || !nonce
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(Error::Configuration);
        }
        let Some(mut store) = Store::open(self, false)? else {
            return Ok(false);
        };
        let network = store.network_guard()?;
        let Some(job) = store.state.job.as_ref() else {
            return Ok(false);
        };
        if job.nonce != nonce {
            return Ok(false);
        }
        let timestamp = now()?;
        let generation = job.generation;
        let batch_id = job.batch.clone();
        let valid = generation == store.state.generation
            && timestamp >= job.created
            && timestamp - job.created <= 30_000;
        store.state.job = None;
        store.save()?;
        if !valid || self.veto() || self.policy.offline || store.state.disabled {
            return Ok(false);
        }
        let Some(batch) = store
            .state
            .batches
            .iter()
            .find(|b| b.id == batch_id)
            .cloned()
        else {
            return Ok(false);
        };
        if !self.allowed(&store.state, batch.collection) {
            return Ok(false);
        }
        let token = if batch.collection == Collection::OptIn {
            Some(
                store
                    .state
                    .identity
                    .as_ref()
                    .ok_or(Error::State)?
                    .token
                    .clone(),
            )
        } else {
            None
        };
        drop(store);
        // Keep the network lock through acknowledgement. Controls cannot report
        // a completed withdrawal while this request is still able to start.
        let response = send(&batch.body, token.as_deref());
        let accepted = response
            .and_then(|body| serde_json::from_str::<Receipt>(&body).ok())
            .is_some_and(|r| {
                r.batch_id == batch.id && r.payload_sha256 == hash(batch.body.as_bytes())
            });
        let mut store = Store::open(self, false)?.ok_or(Error::State)?;
        if store.state.generation == generation {
            if accepted {
                if batch.collection == Collection::OptIn
                    && let Some(identity) = &mut store.state.identity
                {
                    identity.last_accepted_at = timestamp;
                }
                store.state.batches.retain(|b| b.id != batch_id);
                store.state.failures = 0;
                let delay = if store.state.batches.is_empty() && store.state.open.is_empty() {
                    86_400_000
                } else {
                    60_000
                };
                store.state.next_attempt = timestamp.saturating_add(delay);
            } else {
                store.state.failures = store.state.failures.saturating_add(1);
                let seconds = [60, 300, 1800, 3600, 21600, 86400]
                    [store.state.failures.saturating_sub(1).min(5) as usize];
                store.state.next_attempt = timestamp.saturating_add(seconds * 1000);
            }
            store.save()?;
        }
        drop(network);
        Ok(accepted)
    }
}
