use super::{Error, policy, state::State};
use std::fs::{self, File, OpenOptions, TryLockError};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

pub(super) struct Store {
    _lock: Lock,
    dir: PathBuf,
}

pub(super) struct Lock(File);

impl Drop for Lock {
    fn drop(&mut self) {
        // Closing one descriptor need not release a lock if another inherited
        // or duplicated handle still references it. End ownership explicitly.
        let _ = self.0.unlock();
    }
}

fn regular_private(path: &Path) -> Result<(), Error> {
    let meta = fs::symlink_metadata(path).map_err(|_| Error::State)?;
    if !meta.is_file() || meta.file_type().is_symlink() {
        return Err(Error::State);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if meta.permissions().mode() & 0o077 != 0 {
            return Err(Error::State);
        }
    }
    Ok(())
}

fn open_private(path: &Path, create: bool) -> Result<File, Error> {
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
    match fs::symlink_metadata(path) {
        Ok(_) => regular_private(path)?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(Error::State),
    }
    let file = options.open(path).map_err(|_| Error::State)?;
    regular_private(path)?;
    Ok(file)
}

impl Store {
    pub fn allow_explicit_forget(&self) -> Result<(), Error> {
        regular_private(&self.dir.join("state.json"))
    }
    pub fn network_guard(&self) -> Result<Option<Lock>, Error> {
        let guard = open_private(&self.dir.join("network.lock"), true)?;
        match guard.try_lock() {
            Ok(()) => Ok(Some(Lock(guard))),
            Err(TryLockError::WouldBlock) => Ok(None),
            Err(_) => Err(Error::State),
        }
    }
    pub fn claim(dir: &Path, create: bool) -> Result<Option<Self>, Error> {
        if !create
            && !dir
                .join("state.json")
                .try_exists()
                .map_err(|_| Error::State)?
        {
            return Ok(None);
        }
        if !dir.try_exists().map_err(|_| Error::State)? {
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
            builder.create(dir).map_err(|_| Error::State)?;
        }
        let meta = fs::symlink_metadata(dir).map_err(|_| Error::State)?;
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
        let lock = open_private(&dir.join("state.lock"), true)?;
        match lock.try_lock() {
            Ok(()) => {}
            Err(TryLockError::WouldBlock) => return Err(Error::Busy),
            Err(_) => return Err(Error::State),
        }
        let lock = Lock(lock);
        // A crash before rename leaves an uncommitted private write. It must
        // never become new authority or survive a later withdrawal as old usage.
        let pending = dir.join("state.new");
        if pending.try_exists().map_err(|_| Error::State)? {
            regular_private(&pending)?;
            fs::remove_file(pending).map_err(|_| Error::State)?;
        }
        Ok(Some(Self {
            _lock: lock,
            dir: dir.into(),
        }))
    }

    pub fn load(&self, scope: &str) -> Result<State, Error> {
        let path = self.dir.join("state.json");
        match fs::symlink_metadata(&path) {
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(State::new(scope)),
            Err(_) => return Err(Error::State),
        }
        regular_private(&path)?;
        let mut bytes = Vec::new();
        File::open(path)
            .map_err(|_| Error::State)?
            .take(policy::limits().max_local_bytes + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| Error::State)?;
        if bytes.len() as u64 > policy::limits().max_local_bytes {
            return Err(Error::State);
        }
        let state: State = serde_json::from_slice(&bytes).map_err(|_| Error::State)?;
        if state.schema_version != 1 || state.scope != scope {
            return Err(Error::State);
        }
        Ok(state)
    }

    pub fn save(&self, state: &mut State) -> Result<(), Error> {
        state.bound()?;
        let pending = self.dir.join("state.new");
        let mut file = open_private(&pending, true)?;
        serde_json::to_writer(&mut file, state).map_err(|_| Error::State)?;
        file.flush().map_err(|_| Error::State)?;
        file.sync_all().map_err(|_| Error::State)?;
        drop(file);
        fs::rename(pending, self.dir.join("state.json")).map_err(|_| Error::State)?;
        #[cfg(unix)]
        File::open(&self.dir)
            .and_then(|d| d.sync_all())
            .map_err(|_| Error::State)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn completed_lock_ownership_ends_even_if_a_descriptor_was_duplicated() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("lock");
        let file = open_private(&path, true).unwrap();
        file.try_lock().unwrap();
        let duplicated = file.try_clone().unwrap();
        let guard = Lock(file);
        drop(guard);
        let next = open_private(&path, false).unwrap();
        assert!(
            next.try_lock().is_ok(),
            "a surviving duplicate must not prolong completed ownership"
        );
        next.unlock().unwrap();
        drop(duplicated);
    }
}
