use std::fs::{self, File, OpenOptions, TryLockError};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use crate::{Error, HOUR, RETRY_BASE, wire::Release};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct State {
    pub schema_version: u32,
    pub resource: String,
    pub next_check: u64,
    pub failures: u32,
    pub release: Option<Release>,
    pub etag: Option<String>,
    pub noticed_version: Option<String>,
    pub noticed_at: u64,
}

impl State {
    fn empty(resource: &str) -> Self {
        Self {
            schema_version: 1,
            resource: resource.into(),
            next_check: 0,
            failures: 0,
            release: None,
            etag: None,
            noticed_version: None,
            noticed_at: 0,
        }
    }

    pub fn defer(&mut self, now: u64) {
        self.failures = self.failures.saturating_add(1).min(5);
        let delay = (RETRY_BASE << (self.failures - 1)).min(HOUR);
        self.next_check = now.saturating_add(delay);
    }
}

pub(crate) struct Store {
    // Keep a stable inode for the lifetime of every check. Never delete the lock.
    _lock: File,
    path: PathBuf,
}

impl Store {
    pub fn claim(dir: &Path, name: &str) -> Result<Option<Self>, Error> {
        fs::create_dir_all(dir).map_err(|_| Error::Cache)?;
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(dir.join(format!("{name}.lock")))
            .map_err(|_| Error::Cache)?;
        match lock.try_lock() {
            Ok(()) => Ok(Some(Self {
                _lock: lock,
                path: dir.join(format!("{name}.json")),
            })),
            Err(TryLockError::WouldBlock) => Ok(None),
            Err(TryLockError::Error(_)) => Err(Error::Cache),
        }
    }

    pub fn load(&self, resource: &str, now: u64) -> State {
        let read = || -> Option<State> {
            let mut bytes = Vec::new();
            File::open(&self.path)
                .ok()?
                .take(65_537)
                .read_to_end(&mut bytes)
                .ok()?;
            if bytes.len() > 65_536 {
                return None;
            }
            let state: State = serde_json::from_slice(&bytes).ok()?;
            (state.schema_version == 1 && state.resource == resource).then_some(state)
        };
        let mut state = read().unwrap_or_else(|| State::empty(resource));
        if state.next_check > now.saturating_add(HOUR + 1) {
            state.next_check = 0;
        }
        if state.noticed_at > now {
            state.noticed_at = 0;
        }
        // Do not send cache-supplied header data unless it is a bounded opaque validator.
        if !state.etag.as_deref().is_none_or(crate::wire::valid_etag) {
            state.etag = None;
        }
        state
    }

    pub fn save(&self, state: &State) -> Result<(), Error> {
        let parent = self.path.parent().ok_or(Error::Cache)?;
        let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|_| Error::Cache)?;
        serde_json::to_writer(&mut temp, state).map_err(|_| Error::Cache)?;
        temp.flush().map_err(|_| Error::Cache)?;
        temp.persist(&self.path).map_err(|_| Error::Cache)?;
        Ok(())
    }
}
