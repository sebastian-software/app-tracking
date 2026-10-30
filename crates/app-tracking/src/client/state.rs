use super::{Client, Collection, Dimensions, Error, SystemInfo, hash};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions, TryLockError};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

const MAX_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Identity {
    pub id: String,
    pub token: String,
    pub consented_at: u64,
    #[serde(default)]
    pub last_accepted_at: u64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Row {
    pub day: u64,
    pub metric: String,
    pub collection: Collection,
    pub tool_version: String,
    pub dimensions: Dimensions,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system: Option<SystemInfo>,
    pub count: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id_version: Option<u8>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Pending {
    pub id: String,
    pub body: String,
    pub sha256: String,
    pub collection: Collection,
    pub day: u64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Job {
    pub nonce: String,
    pub generation: u64,
    pub created: u64,
    pub batch: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct State {
    pub schema_version: u8,
    pub scope: String,
    pub opt_in: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_permission_prompt_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history: Option<super::history::HistoryChoice>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<super::profile::ProfileChoice>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_v2: Option<super::profile::ProfileChoice>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub public_usage: Option<super::public_usage::PublicUsageChoice>,
    #[serde(default)]
    pub opt_in_scope: Option<String>,
    pub disabled: bool,
    pub deleting: bool,
    pub identity: Option<Identity>,
    pub generation: u64,
    pub open: BTreeMap<String, Row>,
    pub batches: Vec<Pending>,
    pub job: Option<Job>,
    pub next_attempt: u64,
    pub failures: u32,
    pub dropped: u64,
}

impl State {
    fn validate(&self, client: &Client) -> Result<(), Error> {
        if self
            .last_permission_prompt_at
            .is_some_and(|at| at > 253402300799999)
        {
            return Err(Error::State);
        }
        let hex = |s: &str| {
            s.len() == 64
                && s.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        };
        if let Some(id) = &self.identity
            && (!hex(&id.id)
                || !hex(&id.token)
                || id.consented_at > 253402300799999
                || id.last_accepted_at > 253402300799999)
        {
            return Err(Error::State);
        }
        if self.history.as_ref().is_some_and(|h| {
            h.changed_at > 253402300799999
                || (h.enabled
                    && (self.identity.is_none()
                        || self.opt_in != Some(true)
                        || self.disabled
                        || self.deleting))
        }) {
            return Err(Error::State);
        }
        if self.public_usage.as_ref().is_some_and(|p| {
            p.revision.len() > 64
                || p.changed_at > 253402300799999
                || (p.enabled
                    && (self.identity.is_none()
                        || self.opt_in != Some(true)
                        || self.disabled
                        || self.deleting
                        || !self.history.as_ref().is_some_and(|h| h.enabled)))
        }) {
            return Err(Error::State);
        }
        if self.profile.as_ref().is_some_and(|choice| {
            choice.revision.is_empty()
                || choice.revision.len() > 64
                || choice.changed_at > 253402300799999
                || (choice.enabled
                    && (self.identity.is_none()
                        || self.opt_in != Some(true)
                        || self.disabled
                        || self.deleting
                        || choice.profile_id.as_ref().is_none_or(|id| !hex(id))))
                || (!choice.enabled && choice.profile_id.is_some())
        }) {
            return Err(Error::State);
        }
        if self.profile_v2.as_ref().is_some_and(|choice| {
            choice.revision.is_empty()
                || choice.revision.len() > 64
                || choice.changed_at > 253402300799999
                || (choice.enabled
                    && (self.identity.is_none()
                        || self.opt_in != Some(true)
                        || self.disabled
                        || self.deleting
                        || choice.profile_id.as_ref().is_none_or(|id| !hex(id))))
                || (!choice.enabled && choice.profile_id.is_some())
        }) {
            return Err(Error::State);
        }
        if self.opt_in_scope.as_ref().is_some_and(|scope| !hex(scope)) {
            return Err(Error::State);
        }
        let valid_row = |row: &Row| {
            client.metrics.get(&row.metric).is_some_and(|definition| {
                definition.collection == row.collection
                    && definition.valid(&row.dimensions)
                    && row.day <= 2932896
                    && (1..=1_000_000).contains(&row.count)
                    && row.tool_version.len() <= 128
                    && semver::Version::parse(&row.tool_version).is_ok()
                    && match (&row.project_id, row.project_id_version) {
                        (None, None) => true,
                        (Some(id), Some(1)) => {
                            definition.project && row.collection == Collection::OptIn && hex(id)
                        }
                        _ => false,
                    }
                    && match (&row.system, definition.system) {
                        (None, super::SystemContext::None) => true,
                        (Some(system), super::SystemContext::Full) => system.valid(),
                        (Some(system), super::SystemContext::Platform) => {
                            system.valid()
                                && system.os_version == "unknown"
                                && system.cpu_family == "unknown"
                                && system.linux.is_none()
                        }
                        _ => false,
                    }
            })
        };
        for (key, row) in &self.open {
            let mut one = row.clone();
            one.count = 1;
            if !valid_row(row) || serde_json::to_string(&one).map_err(|_| Error::State)? != *key {
                return Err(Error::State);
            }
        }
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Payload {
            schema_version: u8,
            tool_id: String,
            batch_id: String,
            collection: Collection,
            mode: String,
            installation_id: Option<String>,
            consented_at: Option<u64>,
            rows: Vec<Row>,
        }
        for batch in &self.batches {
            let body: Payload = serde_json::from_str(&batch.body).map_err(|_| Error::State)?;
            if body.schema_version != 1
                || body.tool_id != client.tool
                || body.batch_id != batch.id
                || !hex(&batch.id)
                || body.collection != batch.collection
                || body.rows.is_empty()
                || body.rows.len() > 64
                || body.mode != if client.policy.ci { "ci" } else { "local" }
                || body
                    .rows
                    .iter()
                    .any(|row| !valid_row(row) || row.collection != batch.collection)
                || body.rows.iter().map(|row| row.day).min() != Some(batch.day)
                || (body.collection == Collection::OptOut
                    && (body.installation_id.is_some() || body.consented_at.is_some()))
                || (body.collection == Collection::OptIn
                    && self.identity.as_ref().is_none_or(|id| {
                        body.installation_id.as_deref() != Some(id.id.as_str())
                            || body.consented_at != Some(id.consented_at)
                    }))
                || encode(client, self, &batch.id, batch.collection, &body.rows)? != batch.body
            {
                return Err(Error::State);
            }
        }
        Ok(())
    }

    fn new(scope: String) -> Self {
        Self {
            schema_version: 1,
            scope,
            opt_in: None,
            last_permission_prompt_at: None,
            history: None,
            profile: None,
            profile_v2: None,
            public_usage: None,
            opt_in_scope: None,
            disabled: false,
            deleting: false,
            identity: None,
            generation: 0,
            open: BTreeMap::new(),
            batches: vec![],
            job: None,
            next_attempt: 0,
            failures: 0,
            dropped: 0,
        }
    }
    pub fn withdraw_public_usage(&mut self) -> Result<(), Error> {
        if let Some(choice) = &mut self.public_usage
            && choice.enabled
        {
            choice.revision = super::PUBLIC_USAGE_CONSENT_REVISION.into();
            choice.enabled = false;
            choice.changed_at = super::now()?.max(choice.changed_at.saturating_add(1));
            choice.confirmed = false;
        }
        Ok(())
    }
    pub fn withdraw_history(&mut self) -> Result<(), Error> {
        self.withdraw_public_usage()?;
        if let Some(history) = &mut self.history
            && history.enabled
        {
            history.revision = super::history::HISTORY_CONSENT_REVISION.into();
            history.enabled = false;
            history.changed_at = super::now()?.max(history.changed_at.saturating_add(1));
            history.confirmed = false;
        }
        Ok(())
    }
    pub fn withdraw_profile(&mut self) -> Result<(), Error> {
        if let Some(choice) = &mut self.profile
            && choice.enabled
        {
            choice.revision = super::profile::PROFILE_CONSENT_REVISION.into();
            choice.enabled = false;
            choice.profile_id = None;
            choice.confirmed = false;
            choice.changed_at = super::now()?.max(choice.changed_at.saturating_add(1));
        }
        if let Some(choice) = &mut self.profile_v2
            && choice.enabled
        {
            choice.revision = super::profile::PROFILE_CONSENT_REVISION.into();
            choice.enabled = false;
            choice.profile_id = None;
            choice.confirmed = false;
            choice.changed_at = super::now()?.max(choice.changed_at.saturating_add(1));
        }
        Ok(())
    }
    pub fn clear(&mut self) {
        self.open.clear();
        self.batches.clear();
        self.job = None;
    }
    pub fn retain(&mut self, collection: Collection) {
        self.open.retain(|_, row| row.collection == collection);
        self.batches.retain(|batch| batch.collection == collection);
    }
    pub fn prune(&mut self, day: u64) {
        self.open
            .retain(|_, row| row.day <= day && day - row.day <= 6);
        self.batches
            .retain(|batch| batch.day <= day && day - batch.day <= 6);
    }
    pub fn close(&mut self, client: &Client) -> Result<(), Error> {
        // One bounded batch per close; later attempts drain the remaining rows.
        if self.open.is_empty() || self.batches.len() >= 64 {
            return Ok(());
        }
        let collection = self.open.values().next().ok_or(Error::State)?.collection;
        let mut rows = Vec::new();
        let mut keys = Vec::new();
        let id = super::random()?;
        for (key, row) in self
            .open
            .iter()
            .filter(|(_, r)| r.collection == collection)
            .take(64)
        {
            rows.push(row.clone());
            let body = encode(client, self, &id, collection, &rows)?;
            if body.len() > 60_000 {
                rows.pop();
                break;
            }
            keys.push(key.clone());
        }
        if rows.is_empty() {
            return Err(Error::State);
        }
        let body = encode(client, self, &id, collection, &rows)?;
        self.batches.push(Pending {
            id,
            sha256: hash(body.as_bytes()),
            body,
            collection,
            day: rows.iter().map(|r| r.day).min().ok_or(Error::State)?,
        });
        for key in keys {
            self.open.remove(&key);
        }
        Ok(())
    }
}

fn encode(
    client: &Client,
    state: &State,
    id: &str,
    collection: Collection,
    rows: &[Row],
) -> Result<String, Error> {
    let identity = if collection == Collection::OptIn {
        state.identity.as_ref()
    } else {
        None
    };
    let mut value = serde_json::json!({
        "schema_version": 1, "tool_id": client.tool, "batch_id": id,
        "collection": collection, "mode": if client.policy.ci { "ci" } else { "local" }, "rows": rows,
    });
    if let Some(identity) = identity {
        value["installation_id"] = identity.id.clone().into();
        value["consented_at"] = identity.consented_at.into();
    } else if collection == Collection::OptIn {
        return Err(Error::State);
    }
    value.sort_all_objects();
    serde_json::to_string(&value).map_err(|_| Error::State)
}

pub(super) struct Guard(File);
impl Drop for Guard {
    fn drop(&mut self) {
        let _ = self.0.unlock();
    }
}

pub(super) fn private_file(path: &Path, create: bool) -> Result<File, Error> {
    let metadata = fs::symlink_metadata(path).ok();
    if metadata
        .as_ref()
        .is_some_and(|meta| !meta.is_file() || meta.file_type().is_symlink())
    {
        return Err(Error::State);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.is_some_and(|meta| meta.permissions().mode() & 0o077 != 0) {
            return Err(Error::State);
        }
    }
    let mut options = OpenOptions::new();
    options
        .read(true)
        .write(true)
        .create(create)
        .truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path).map_err(|_| Error::State)
}

pub(super) fn lock(path: &Path) -> Result<Guard, Error> {
    let file = private_file(path, true)?;
    match file.try_lock() {
        Ok(()) => Ok(Guard(file)),
        Err(TryLockError::WouldBlock) => Err(Error::Busy),
        Err(_) => Err(Error::State),
    }
}

pub(super) struct Store {
    _lock: Guard,
    directory: PathBuf,
    pub state: State,
}

impl Store {
    pub fn open(client: &Client, create: bool) -> Result<Option<Self>, Error> {
        let directory = &client.directory;
        match fs::symlink_metadata(directory) {
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
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
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
                builder.create(directory).map_err(|_| Error::State)?;
            }
            Err(_) => return Err(Error::State),
        }
        let guard = lock(&directory.join("state.lock"))?;
        let path = directory.join("state.json");
        let mut state = match fs::symlink_metadata(&path) {
            Ok(_) => {
                let mut bytes = Vec::new();
                private_file(&path, false)?
                    .take(MAX_BYTES + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|_| Error::State)?;
                if bytes.len() as u64 > MAX_BYTES {
                    return Err(Error::State);
                }
                serde_json::from_slice::<State>(&bytes).map_err(|_| Error::State)?
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => State::new(client.scope()),
            Err(_) => return Err(Error::State),
        };
        if state.schema_version != 1
            || state.scope != client.scope()
            || state.open.len() > 4096
            || state.batches.len() > 64
            || (state.opt_in == Some(true) && state.identity.is_none())
            || state
                .batches
                .iter()
                .any(|b| b.body.len() > 60_000 || hash(b.body.as_bytes()) != b.sha256)
        {
            return Err(Error::State);
        }
        // A changed disclosure cannot submit old optional batches or become
        // unusable because an earlier metric no longer exists in the catalog.
        if state.opt_in_scope.as_ref() != Some(&client.opt_in_scope) {
            state.retain(Collection::OptOut);
        }
        state.validate(client)?;
        Ok(Some(Self {
            _lock: guard,
            directory: directory.clone(),
            state,
        }))
    }

    pub fn network_guard(&self) -> Result<Guard, Error> {
        lock(&self.directory.join("network.lock"))
    }

    pub fn save(&mut self) -> Result<(), Error> {
        let bytes = loop {
            let bytes = serde_json::to_vec(&self.state).map_err(|_| Error::State)?;
            if bytes.len() as u64 <= MAX_BYTES {
                break bytes;
            }
            let Some((_, row)) = self.state.open.pop_first() else {
                return Err(Error::State);
            };
            self.state.dropped = self.state.dropped.saturating_add(u64::from(row.count));
        };
        let target = self.directory.join("state.json");
        // Validate the existing target, including a dangling symlink.
        if fs::symlink_metadata(&target).is_ok() {
            drop(private_file(&target, false)?);
        }
        let mut temporary =
            tempfile::NamedTempFile::new_in(&self.directory).map_err(|_| Error::State)?;
        temporary.write_all(&bytes).map_err(|_| Error::State)?;
        temporary.as_file().sync_all().map_err(|_| Error::State)?;
        temporary.persist(target).map_err(|_| Error::State)?;
        #[cfg(unix)]
        File::open(&self.directory)
            .and_then(|f| f.sync_all())
            .map_err(|_| Error::State)?;
        Ok(())
    }
}
