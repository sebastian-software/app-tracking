//! Optional shared random local profiles. Construction never reads profile state.
use super::{Client, Collection, Error, PermissionOutcome, Store, hash, now, random};
use serde::{Deserialize, Serialize};
use std::fs;
#[cfg(unix)]
use std::fs::File;
use std::io::{IsTerminal, Read, Write};
use std::path::PathBuf;
use std::time::Duration;

pub const PROFILE_CONSENT_REVISION: &str = "profile-linking-v1";

/// The same disclosure is used by terminal dialogs and host settings commands.
pub const PROFILE_NOTICE: &str = "Sebastian Software GmbH uses optional profile linking to understand which of our tools are used together and plan product improvements. A random identifier in your private local profile can link future opt-in reports from participating tools, each requiring its own permission. It is not a verified person or physical machine; copied profile files represent the same profile. Tool credentials stay separate. Linking starts from the UTC date after acknowledgement, is local-use only, and does not grant longer retention or public release. Detailed usage remains limited to 90 days. You can unlink this tool or reset the shared profile for all tools. Reset removes links, not the tools' independent usage reports. Offline changes remain pending until acknowledged. Active profile metadata lasts while active links remain; inactive/reset metadata expires after 90 days, with physical cleanup within another 24 hours. Declining does not limit the tool or update checks. Privacy and rights: https://sebastian-software.com/privacy#tool-usage-profiles (contact: info@sebastian-software.de).";

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ProfileChoice {
    pub revision: String,
    pub enabled: bool,
    pub changed_at: u64,
    pub confirmed: bool,
    pub profile_id: Option<String>,
}
#[derive(Debug, Serialize)]
pub struct ProfilePermissionStatus {
    pub decision: super::OptInDecision,
    pub pending: bool,
    pub reset_pending: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SharedState {
    schema_version: u8,
    origin: String,
    profile_id: String,
    token: String,
    reset_pending: bool,
}
impl SharedState {
    fn new(origin: &str) -> Result<Self, Error> {
        Ok(Self {
            schema_version: 1,
            origin: origin.into(),
            profile_id: random()?,
            token: random()?,
            reset_pending: false,
        })
    }
}
struct ProfileFile {
    _lock: super::state::Guard,
    directory: PathBuf,
    state: SharedState,
}
impl ProfileFile {
    fn open(client: &Client, create: bool) -> Result<Option<Self>, Error> {
        if client.policy.ci {
            return Err(Error::AdditionalPermission);
        }
        let root = client.profile_root.as_ref().ok_or(Error::Configuration)?;
        let directory = root
            .join("profiles-v1")
            .join(hash(client.origin.as_bytes()));
        match fs::symlink_metadata(&directory) {
            Ok(meta) => {
                if !meta.is_dir() || meta.file_type().is_symlink() {
                    return Err(Error::State);
                }
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    if meta.permissions().mode() & 0o077 != 0 {
                        return Err(Error::State);
                    }
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if !create {
                    return Ok(None);
                }
                let mut builder = fs::DirBuilder::new();
                builder.recursive(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::DirBuilderExt;
                    builder.mode(0o700);
                }
                builder.create(&directory).map_err(|_| Error::State)?;
            }
            Err(_) => return Err(Error::State),
        }
        let guard = super::state::lock(&directory.join("profile.lock"))?;
        let path = directory.join("profile.json");
        let state = match fs::symlink_metadata(&path) {
            Ok(_) => {
                let mut bytes = Vec::new();
                super::state::private_file(&path, false)?
                    .take(4097)
                    .read_to_end(&mut bytes)
                    .map_err(|_| Error::State)?;
                if bytes.len() > 4096 {
                    return Err(Error::State);
                }
                serde_json::from_slice::<SharedState>(&bytes).map_err(|_| Error::State)?
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if !create {
                    return Ok(None);
                }
                SharedState::new(&client.origin)?
            }
            Err(_) => return Err(Error::State),
        };
        let hex = |value: &str| {
            value.len() == 64
                && value
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        };
        if state.schema_version != 1
            || state.origin != client.origin
            || !hex(&state.profile_id)
            || !hex(&state.token)
        {
            return Err(Error::State);
        }
        let file = Self {
            _lock: guard,
            directory,
            state,
        };
        if create {
            file.save()?;
        }
        Ok(Some(file))
    }
    fn save(&self) -> Result<(), Error> {
        let path = self.directory.join("profile.json");
        if fs::symlink_metadata(&path).is_ok() {
            drop(super::state::private_file(&path, false)?);
        }
        let mut temporary =
            tempfile::NamedTempFile::new_in(&self.directory).map_err(|_| Error::State)?;
        temporary
            .write_all(&serde_json::to_vec(&self.state).map_err(|_| Error::State)?)
            .map_err(|_| Error::State)?;
        temporary.as_file().sync_all().map_err(|_| Error::State)?;
        temporary.persist(path).map_err(|_| Error::State)?;
        #[cfg(unix)]
        File::open(&self.directory)
            .and_then(|f| f.sync_all())
            .map_err(|_| Error::State)?;
        Ok(())
    }
}

fn settings_request(
    method: &str,
    url: &str,
    token: &str,
    tool: &str,
    body: Option<&str>,
) -> Option<(u16, String)> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(5)))
        .max_redirects(0)
        .max_response_header_size(16_384)
        .http_status_as_error(false)
        .build()
        .into();
    let response = if method == "PUT" {
        agent
            .put(url)
            .header("Authorization", format!("Bearer {token}"))
            .header("App-Tracking-Tool", tool)
            .header("Content-Type", "application/json")
            .send(body?.as_bytes())
    } else {
        agent
            .delete(url)
            .header("Authorization", format!("Bearer {token}"))
            .call()
    };
    let mut response = response.ok()?;
    if response
        .headers()
        .get("cache-control")
        .is_none_or(|value| value != "no-store")
    {
        return None;
    }
    let status = response.status().as_u16();
    let body = response
        .body_mut()
        .with_config()
        .limit(2048)
        .read_to_string()
        .ok()?;
    Some((status, body))
}
#[derive(Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct LinkReceipt {
    schema_version: u8,
    revision: String,
    enabled: bool,
    changed_at: u64,
    profile_id: Option<String>,
}
#[derive(Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct ResetReceipt {
    schema_version: u8,
    revision: String,
    profile_id: String,
    status: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MissingReceipt {
    schema_version: u8,
    error: MissingCode,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MissingCode {
    code: String,
}
impl Client {
    /// Select one private user-profile root shared by participating tools. No I/O.
    /// CI is never linked, including explicitly opted-in isolated CI reporting.
    pub fn with_shared_profile(mut self, root: impl Into<PathBuf>) -> Self {
        self.profile_root = Some(root.into());
        self
    }

    /// Save a separate linking choice locally; ordinary usage consent is required.
    /// No existing reporting identity is linked until explicit synchronization.
    pub fn set_profile_linking(&self, enabled: bool) -> Result<(), Error> {
        if self.policy.ci {
            return Err(Error::AdditionalPermission);
        }
        let Some(mut store) = Store::open(self, !enabled)? else {
            return Err(Error::AdditionalPermission);
        };
        let _network = store.network_guard()?;
        self.save_profile_choice(&mut store, enabled)
    }
    fn save_profile_choice(&self, store: &mut Store, enabled: bool) -> Result<(), Error> {
        if enabled && !self.allowed(&store.state, Collection::OptIn) {
            return Err(Error::AdditionalPermission);
        }
        let profile = if enabled {
            Some(ProfileFile::open(self, true)?.ok_or(Error::State)?)
        } else {
            None
        };
        if profile
            .as_ref()
            .is_some_and(|file| file.state.reset_pending)
        {
            return Err(Error::PreviousIdentity);
        }
        let id = profile.as_ref().map(|file| file.state.profile_id.clone());
        let mut timestamp = now()?;
        if let Some(choice) = &store.state.profile {
            if choice.revision == PROFILE_CONSENT_REVISION
                && choice.enabled == enabled
                && choice.profile_id == id
                && (choice.confirmed || timestamp.saturating_sub(choice.changed_at) < 7_776_000_000)
            {
                return Ok(());
            }
            timestamp = timestamp.max(choice.changed_at.saturating_add(1));
        }
        store.state.profile = Some(ProfileChoice {
            revision: PROFILE_CONSENT_REVISION.into(),
            enabled,
            changed_at: timestamp,
            confirmed: store.state.identity.is_none(),
            profile_id: id,
        });
        store.state.generation = store.state.generation.saturating_add(1);
        store.state.job = None;
        store.save()
    }
    pub fn profile_status(&self) -> Result<ProfilePermissionStatus, Error> {
        if self.policy.ci {
            return Ok(ProfilePermissionStatus {
                decision: super::OptInDecision::Undecided,
                pending: false,
                reset_pending: false,
            });
        }
        let store = Store::open(self, false)?;
        let choice = store
            .as_ref()
            .and_then(|store| store.state.profile.as_ref());
        if choice.is_none_or(|choice| !choice.enabled) {
            return Ok(ProfilePermissionStatus {
                decision: super::OptInDecision::from(choice.map(|choice| choice.enabled)),
                pending: choice.is_some_and(|choice| !choice.confirmed),
                reset_pending: false,
            });
        }
        let profile = ProfileFile::open(self, false)?;
        let reset_pending = profile
            .as_ref()
            .is_some_and(|profile| profile.state.reset_pending);
        let matches = profile.as_ref().is_some_and(|profile| {
            choice.is_some_and(|choice| choice.revision == PROFILE_CONSENT_REVISION)
                && Some(&profile.state.profile_id)
                    == choice.and_then(|choice| choice.profile_id.as_ref())
        });
        Ok(ProfilePermissionStatus {
            decision: if matches
                && !reset_pending
                && choice.is_some_and(|choice| {
                    choice.confirmed
                        || now()
                            .is_ok_and(|at| at.saturating_sub(choice.changed_at) < 7_776_000_000)
                }) {
                super::OptInDecision::Granted
            } else {
                super::OptInDecision::Undecided
            },
            pending: choice.is_some_and(|choice| !choice.confirmed) || reset_pending,
            reset_pending,
        })
    }
    /// The library owns the optional dialog; saved refusals remain effective.
    pub fn request_profile_linking(&self, reason: &str) -> Result<PermissionOutcome, Error> {
        if reason.trim().is_empty()
            || reason.len() > 4096
            || reason
                .chars()
                .any(|c| c.is_control() && c != '\n' && c != '\t')
        {
            return Err(Error::Configuration);
        }
        if self.policy.ci || self.profile_root.is_none() || self.is_background_worker() {
            return Ok(PermissionOutcome::Unavailable);
        }
        let Some(store) = Store::open(self, false)? else {
            return Ok(PermissionOutcome::Unavailable);
        };
        if !self.allowed(&store.state, Collection::OptIn) {
            return Ok(PermissionOutcome::Unavailable);
        }
        let generation = store.state.generation;
        drop(store);
        let status = self.profile_status()?;
        if matches!(status.decision, super::OptInDecision::Declined) {
            return Ok(PermissionOutcome::Declined);
        }
        if matches!(status.decision, super::OptInDecision::Granted) {
            return Ok(PermissionOutcome::Granted);
        }
        if status.reset_pending
            || self.interaction != super::Interaction::Terminal
            || !std::io::stdin().is_terminal()
            || !std::io::stderr().is_terminal()
        {
            return Ok(PermissionOutcome::Unavailable);
        }
        let prompt = format!(
            "\nOptional cross-tool profile linking for {}\n\n{}\n\n{}\n\nAllow profile linking? [y/N] ",
            self.tool,
            reason.trim(),
            PROFILE_NOTICE
        );
        let Some(enabled) = super::permission::ask(
            &mut std::io::stdin().lock(),
            &mut std::io::stderr().lock(),
            &prompt,
        )?
        else {
            return Ok(PermissionOutcome::Unavailable);
        };
        // Check under the same state lock that saves the new choice.
        let Some(mut store) = Store::open(self, false)? else {
            return Ok(PermissionOutcome::Unavailable);
        };
        let _network = store.network_guard()?;
        if !self.allowed(&store.state, Collection::OptIn)
            || (enabled && store.state.generation != generation)
        {
            return Ok(PermissionOutcome::Unavailable);
        }
        self.save_profile_choice(&mut store, enabled)?;
        Ok(if enabled {
            PermissionOutcome::Granted
        } else {
            PermissionOutcome::Declined
        })
    }
    /// Explicit settings-network operation; failed/offline choices stay pending.
    pub fn sync_profile_linking(&self) -> Result<bool, Error> {
        self.sync_profile_with(|url, token, body| {
            settings_request("PUT", url, token, &self.tool, Some(body))
        })
    }
    fn sync_profile_with(
        &self,
        send: impl FnOnce(&str, &str, &str) -> Option<(u16, String)>,
    ) -> Result<bool, Error> {
        if self.policy.offline || self.policy.ci {
            return Ok(false);
        }
        let Some(mut store) = Store::open(self, false)? else {
            return Ok(false);
        };
        let _network = store.network_guard()?;
        let Some(choice) = store.state.profile.clone() else {
            return Ok(false);
        };
        if choice.enabled
            && (choice.revision != PROFILE_CONSENT_REVISION
                || !self.allowed(&store.state, Collection::OptIn))
        {
            return Ok(false);
        }
        if choice.enabled
            && !choice.confirmed
            && now()?.saturating_sub(choice.changed_at) >= 7_776_000_000
        {
            return Ok(false);
        }
        let profile = if choice.enabled {
            ProfileFile::open(self, false)?
        } else {
            None
        };
        if choice.enabled
            && profile.as_ref().is_none_or(|profile| {
                profile.state.reset_pending
                    || Some(&profile.state.profile_id) != choice.profile_id.as_ref()
            })
        {
            return Ok(false);
        }
        if choice.confirmed {
            return Ok(true);
        }
        let Some(identity) = store.state.identity.as_ref() else {
            return Ok(false);
        };
        let token = profile.as_ref().map(|profile| profile.state.token.clone());
        let body=serde_json::json!({"schema_version":1,"revision":PROFILE_CONSENT_REVISION,"enabled":choice.enabled,"changed_at":choice.changed_at,"profile_id":choice.profile_id,"profile_token":token}).to_string();
        let Some((200, receipt)) = send(
            &format!("{}/v1/profile-links/events/{}", self.origin, identity.id),
            &identity.token,
            &body,
        ) else {
            return Ok(false);
        };
        let expected = LinkReceipt {
            schema_version: 1,
            revision: PROFILE_CONSENT_REVISION.into(),
            enabled: choice.enabled,
            changed_at: choice.changed_at,
            profile_id: choice.profile_id,
        };
        if serde_json::from_str::<LinkReceipt>(&receipt).ok().as_ref() != Some(&expected) {
            return Ok(false);
        }
        store.state.profile.as_mut().ok_or(Error::State)?.confirmed = true;
        store.save()?;
        Ok(true)
    }
    /// Explicit shared-reset status, including after this tool has opted out.
    pub fn profile_reset_pending(&self) -> Result<bool, Error> {
        if self.policy.ci || self.profile_root.is_none() {
            return Ok(false);
        }
        Ok(ProfileFile::open(self, false)?.is_some_and(|profile| profile.state.reset_pending))
    }
    /// Queue a shared-profile reset locally. Independent tool reports remain.
    pub fn request_profile_reset(&self) -> Result<(), Error> {
        if let Some(mut profile) = ProfileFile::open(self, false)? {
            profile.state.reset_pending = true;
            profile.save()?;
        }
        Ok(())
    }
    pub fn sync_profile_reset(&self) -> Result<bool, Error> {
        self.reset_profile_with(|url, token| {
            settings_request("DELETE", url, token, &self.tool, None)
        })
    }
    fn reset_profile_with(
        &self,
        send: impl FnOnce(&str, &str) -> Option<(u16, String)>,
    ) -> Result<bool, Error> {
        if self.policy.offline || self.policy.ci {
            return Ok(false);
        }
        let Some(mut profile) = ProfileFile::open(self, false)? else {
            return Ok(false);
        };
        if !profile.state.reset_pending {
            return Ok(true);
        }
        let Some((status, body)) = send(
            &format!(
                "{}/v1/shared-profiles/{}",
                self.origin, profile.state.profile_id
            ),
            &profile.state.token,
        ) else {
            return Ok(false);
        };
        let expected = ResetReceipt {
            schema_version: 1,
            revision: PROFILE_CONSENT_REVISION.into(),
            profile_id: profile.state.profile_id.clone(),
            status: "deleted".into(),
        };
        let deleted = status == 200
            && serde_json::from_str::<ResetReceipt>(&body).ok().as_ref() == Some(&expected);
        let absent = status == 404
            && serde_json::from_str::<MissingReceipt>(&body).is_ok_and(|receipt| {
                receipt.schema_version == 1 && receipt.error.code == "installation_not_found"
            });
        if !deleted && !absent {
            return Ok(false);
        }
        profile.state = SharedState::new(&self.origin)?;
        profile.save()?;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::super::{Interaction, OptInDecision};
    use super::*;
    fn client(root: &std::path::Path, shared: &std::path::Path, tool: &str) -> Client {
        Client::registered("https://example.test", root, tool, "1.0.0")
            .unwrap()
            .with_shared_profile(shared)
            .with_interaction(Interaction::Never)
    }
    fn acknowledge(_: &str, _: &str, body: &str) -> Option<(u16, String)> {
        let mut value: serde_json::Value = serde_json::from_str(body).unwrap();
        value.as_object_mut().unwrap().remove("profile_token");
        Some((200, value.to_string()))
    }
    #[test]
    fn additional_grants_share_only_the_profile_and_reset_never_regrants_other_tools() {
        let root = tempfile::tempdir().unwrap();
        let shared = root.path().join("shared");
        let dalo = client(&root.path().join("dalo"), &shared, "dalo");
        let palamedes = client(&root.path().join("palamedes"), &shared, "palamedes");
        assert!(dalo.set_profile_linking(true).is_err());
        assert!(!shared.exists());
        dalo.set_opt_in(true).unwrap();
        palamedes.set_opt_in(true).unwrap();
        assert!(!shared.exists());
        assert_eq!(
            dalo.request_profile_linking("Understand tool overlap.")
                .unwrap(),
            PermissionOutcome::Unavailable
        );
        dalo.set_profile_linking(true).unwrap();
        palamedes.set_profile_linking(true).unwrap();
        let one = Store::open(&dalo, false).unwrap().unwrap();
        let two = Store::open(&palamedes, false).unwrap().unwrap();
        assert_ne!(
            one.state.identity.as_ref().unwrap().id,
            two.state.identity.as_ref().unwrap().id
        );
        assert_ne!(
            one.state.identity.as_ref().unwrap().token,
            two.state.identity.as_ref().unwrap().token
        );
        assert_eq!(
            one.state.profile.as_ref().unwrap().profile_id,
            two.state.profile.as_ref().unwrap().profile_id
        );
        let old_id = one
            .state
            .profile
            .as_ref()
            .unwrap()
            .profile_id
            .clone()
            .unwrap();
        drop(one);
        drop(two);
        assert!(!dalo.preview().unwrap().contains(&old_id));
        assert!(
            !dalo
                .sync_profile_with(|_, _, body| Some((200, body.into())))
                .unwrap()
        ); // echoing the secret is not an acknowledgement.
        assert!(dalo.profile_status().unwrap().pending);
        assert!(dalo.sync_profile_with(acknowledge).unwrap());
        assert!(palamedes.sync_profile_with(acknowledge).unwrap());
        assert_eq!(
            dalo.request_profile_linking("Understand overlap.").unwrap(),
            PermissionOutcome::Granted
        );
        dalo.set_profile_linking(false).unwrap();
        assert!(
            dalo.sync_profile_with(|url, token, body| {
                assert!(url.contains("profile-links/events/"));
                assert!(!body.contains(token));
                let value: serde_json::Value = serde_json::from_str(body).unwrap();
                assert!(value["profile_id"].is_null());
                assert!(value["profile_token"].is_null());
                acknowledge(url, token, body)
            })
            .unwrap()
        );
        assert!(matches!(
            palamedes.profile_status().unwrap().decision,
            OptInDecision::Granted
        ));
        palamedes.request_profile_reset().unwrap();
        assert!(palamedes.profile_status().unwrap().reset_pending);
        assert!(
            !palamedes
                .reset_profile_with(|_, _| Some((404, "{\"error\":\"not_found\"}".into())))
                .unwrap()
        );
        assert!(palamedes.reset_profile_with(|url,token|{
            assert!(url.ends_with(&old_id));assert_eq!(token.len(),64);
            Some((200,serde_json::json!({"schema_version":1,"revision":PROFILE_CONSENT_REVISION,"profile_id":old_id,"status":"deleted"}).to_string()))
        }).unwrap());
        assert!(matches!(
            palamedes.profile_status().unwrap().decision,
            OptInDecision::Undecided
        ));
        assert!(
            !palamedes
                .sync_profile_with(|_, _, _| panic!("reset must not silently relink"))
                .unwrap()
        );
        assert!(palamedes.status().unwrap().opt_in);
        assert_eq!(
            dalo.request_profile_linking("Understand overlap.").unwrap(),
            PermissionOutcome::Declined
        );
    }
    #[test]
    fn offline_withdrawal_ci_and_saved_refusals_do_not_touch_a_shared_identity() {
        let root = tempfile::tempdir().unwrap();
        let shared = root.path().join("shared");
        let dalo = client(&root.path().join("tool"), &shared, "dalo");
        dalo.set_profile_linking(false).unwrap();
        dalo.set_opt_in(true).unwrap();
        assert_eq!(
            dalo.request_profile_linking("Understand overlap.").unwrap(),
            PermissionOutcome::Declined
        );
        assert!(!shared.exists());
        dalo.set_profile_linking(true).unwrap();
        let offline = dalo.with_policy(crate::telemetry::Policy {
            offline: true,
            ..Default::default()
        });
        offline.set_opt_in(false).unwrap();
        assert!(matches!(
            offline.profile_status().unwrap().decision,
            OptInDecision::Declined
        ));
        assert!(offline.profile_status().unwrap().pending);
        offline.request_profile_reset().unwrap();
        assert!(offline.profile_reset_pending().unwrap());
        assert!(
            !offline
                .sync_profile_with(|_, _, _| panic!("offline must not send"))
                .unwrap()
        );
        let ci = client(
            &root.path().join("ci-tool"),
            &root.path().join("ci-shared"),
            "dalo",
        )
        .with_policy(crate::telemetry::Policy {
            ci: true,
            isolated_ci_state: true,
            ..Default::default()
        });
        assert!(ci.set_profile_linking(true).is_err());
        assert_eq!(
            ci.request_profile_linking("Understand overlap.").unwrap(),
            PermissionOutcome::Unavailable
        );
        assert!(ci.request_profile_reset().is_err());
        assert!(!root.path().join("ci-shared").exists());
    }
    #[test]
    fn creation_is_locked_and_existing_state_survives_upgrades_and_missing_state() {
        let root = tempfile::tempdir().unwrap();
        let shared = root.path().join("shared");
        let one = client(&root.path().join("a"), &shared, "dalo");
        let two = client(&root.path().join("b"), &shared, "palamedes");
        one.set_opt_in(true).unwrap();
        two.set_opt_in(true).unwrap();
        one.set_profile_linking(true).unwrap();
        let locked = ProfileFile::open(&one, false).unwrap().unwrap();
        let id = locked.state.profile_id.clone();
        assert!(matches!(two.set_profile_linking(true), Err(Error::Busy)));
        drop(locked);
        two.set_profile_linking(true).unwrap();
        assert_eq!(
            ProfileFile::open(&two, false)
                .unwrap()
                .unwrap()
                .state
                .profile_id,
            id
        );
        let upgraded = Client::registered(
            "https://example.test",
            root.path().join("b"),
            "palamedes",
            "2.0.0",
        )
        .unwrap()
        .with_shared_profile(&shared);
        assert!(matches!(
            upgraded.profile_status().unwrap().decision,
            OptInDecision::Granted
        ));
        let path = ProfileFile::open(&two, false)
            .unwrap()
            .unwrap()
            .directory
            .join("profile.json");
        fs::remove_file(path).unwrap();
        assert!(matches!(
            two.profile_status().unwrap().decision,
            OptInDecision::Undecided
        ));
        assert!(
            !two.sync_profile_with(|_, _, _| panic!("missing profile state must not relink"))
                .unwrap()
        );
    }
    #[test]
    fn a_never_registered_profile_can_reset_only_with_the_fixed_missing_receipt() {
        let root = tempfile::tempdir().unwrap();
        let client = client(
            &root.path().join("tool"),
            &root.path().join("shared"),
            "dalo",
        );
        client.set_opt_in(true).unwrap();
        client.set_profile_linking(true).unwrap();
        client.request_profile_reset().unwrap();
        assert!(
            !client
                .reset_profile_with(|_, _| Some((
                    404,
                    "{\"schema_version\":1,\"error\":{\"code\":\"not_found\"}}".into()
                )))
                .unwrap()
        );
        assert!(client.profile_reset_pending().unwrap());
        assert!(
            client
                .reset_profile_with(|_, _| Some((
                    404,
                    "{\"schema_version\":1,\"error\":{\"code\":\"installation_not_found\"}}".into()
                )))
                .unwrap()
        );
        assert!(!client.profile_reset_pending().unwrap());
        assert!(matches!(
            client.profile_status().unwrap().decision,
            OptInDecision::Undecided
        ));
    }
    #[test]
    fn changed_scope_and_expired_pending_grants_need_another_explicit_choice() {
        let root = tempfile::tempdir().unwrap();
        let client = client(
            &root.path().join("tool"),
            &root.path().join("shared"),
            "dalo",
        );
        client.set_opt_in(true).unwrap();
        client.set_profile_linking(true).unwrap();
        {
            let mut store = Store::open(&client, false).unwrap().unwrap();
            store.state.profile.as_mut().unwrap().changed_at = now().unwrap() - 91 * 86_400_000;
            store.save().unwrap();
        }
        assert!(matches!(
            client.profile_status().unwrap().decision,
            OptInDecision::Undecided
        ));
        assert_eq!(
            client
                .request_profile_linking("Understand overlap.")
                .unwrap(),
            PermissionOutcome::Unavailable
        );
        client.set_profile_linking(true).unwrap();
        assert!(matches!(
            client.profile_status().unwrap().decision,
            OptInDecision::Granted
        ));
        {
            let mut store = Store::open(&client, false).unwrap().unwrap();
            store.state.profile.as_mut().unwrap().revision = "different-scope".into();
            store.save().unwrap();
        }
        assert!(matches!(
            client.profile_status().unwrap().decision,
            OptInDecision::Undecided
        ));
        assert!(
            !client
                .sync_profile_with(|_, _, _| panic!("unknown scope must not link"))
                .unwrap()
        );
        client.set_profile_linking(false).unwrap();
        assert!(client.sync_profile_with(acknowledge).unwrap());
    }
    #[test]
    fn copied_state_represents_the_same_profile_but_never_supplies_tool_consent() {
        let root = tempfile::tempdir().unwrap();
        let one = client(
            &root.path().join("one"),
            &root.path().join("shared-one"),
            "dalo",
        );
        one.set_opt_in(true).unwrap();
        one.set_profile_linking(true).unwrap();
        let original = ProfileFile::open(&one, false).unwrap().unwrap();
        let id = original.state.profile_id.clone();
        let two = client(
            &root.path().join("two"),
            &root.path().join("shared-two"),
            "palamedes",
        );
        let copy = ProfileFile::open(&two, true).unwrap().unwrap();
        fs::copy(
            original.directory.join("profile.json"),
            copy.directory.join("profile.json"),
        )
        .unwrap();
        drop(copy);
        drop(original);
        two.set_opt_in(true).unwrap();
        assert!(matches!(
            two.profile_status().unwrap().decision,
            OptInDecision::Undecided
        ));
        two.set_profile_linking(true).unwrap();
        assert_eq!(
            ProfileFile::open(&two, false)
                .unwrap()
                .unwrap()
                .state
                .profile_id,
            id
        );
    }
}
