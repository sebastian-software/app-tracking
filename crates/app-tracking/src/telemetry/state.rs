use super::{Decision, DeletionStatus, Error, GrantSource, Row, policy, wire};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub(super) const DAY_MS: u64 = 86_400_000;
pub(super) const INACTIVITY_MS: u64 = 90 * DAY_MS;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Grant {
    pub revision: String,
    pub source: GrantSource,
    pub at_ms: u64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Authority {
    pub id: String,
    pub token: String,
    pub declaration: String,
    pub registered: bool,
    pub last_remote_ms: u64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Batch {
    pub id: String,
    pub body: String,
    pub hash: String,
    pub count: u64,
    pub oldest_day: String,
    pub created_ms: u64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct State {
    pub schema_version: u8,
    pub scope: String,
    pub decision: Decision,
    pub grant: Option<Grant>,
    pub authority: Option<Authority>,
    pub deletion: DeletionStatus,
    pub withdrawn_ms: Option<u64>,
    pub generation: u64,
    pub attempt: u64,
    pub failures: usize,
    pub next_attempt_ms: u64,
    pub next_close_ms: Option<u64>,
    pub last_invocation_ms: u64,
    pub terminal_status: Option<u16>,
    pub open: BTreeMap<String, Row>,
    pub batches: Vec<Batch>,
    pub daily_counts: BTreeMap<String, u64>,
    pub dropped_invocations: u64,
}

impl State {
    pub fn new(scope: &str) -> Self {
        Self {
            schema_version: 1,
            scope: scope.into(),
            decision: Decision::Undecided,
            grant: None,
            authority: None,
            deletion: DeletionStatus::None,
            withdrawn_ms: None,
            generation: 0,
            attempt: 0,
            failures: 0,
            next_attempt_ms: 0,
            next_close_ms: None,
            last_invocation_ms: 0,
            terminal_status: None,
            open: BTreeMap::new(),
            batches: Vec::new(),
            daily_counts: BTreeMap::new(),
            dropped_invocations: 0,
        }
    }

    pub fn clear_usage(&mut self) {
        self.open.clear();
        self.batches.clear();
        self.daily_counts.clear();
        self.next_close_ms = None;
        self.dropped_invocations = 0;
    }

    pub fn withdraw(&mut self, decision: Decision, now: u64) {
        self.generation = self.generation.saturating_add(1);
        self.decision = decision;
        self.grant = None;
        if let Some(authority) = &mut self.authority {
            authority.declaration.clear();
            authority.last_remote_ms = 0;
            authority.registered = false;
        }
        self.clear_usage();
        self.last_invocation_ms = 0;
        self.withdrawn_ms.get_or_insert(now);
        self.terminal_status = None;
    }

    pub fn prune(&mut self, now: u64) -> Result<(), Error> {
        if self.deletion == DeletionStatus::Pending
            && self
                .withdrawn_ms
                .is_some_and(|at| now.saturating_sub(at) >= INACTIVITY_MS)
        {
            self.authority = None;
            self.deletion = DeletionStatus::Unverified;
            self.terminal_status = None;
        }
        if self.decision == Decision::Enabled
            && (now.saturating_sub(self.last_invocation_ms) >= INACTIVITY_MS
                || self
                    .authority
                    .as_ref()
                    .is_some_and(|a| now.saturating_sub(a.last_remote_ms) >= INACTIVITY_MS)
                || (self.authority.is_none()
                    && self
                        .grant
                        .as_ref()
                        .is_some_and(|g| now.saturating_sub(g.at_ms) >= INACTIVITY_MS)))
        {
            self.withdraw(Decision::Expired, now);
        }
        let oldest = wire::day(now.saturating_sub(300_000).saturating_sub(6 * DAY_MS))?;
        let mut dropped = 0u64;
        self.open.retain(|_, row| {
            if row.day < oldest {
                dropped = dropped.saturating_add(u64::from(row.count));
                false
            } else {
                true
            }
        });
        self.batches.retain(|batch| {
            if batch.oldest_day < oldest
                || now.saturating_sub(batch.created_ms) > 7 * DAY_MS + 300_000
            {
                dropped = dropped.saturating_add(batch.count);
                false
            } else {
                true
            }
        });
        self.daily_counts.retain(|day, _| day >= &oldest);
        self.dropped_invocations = self.dropped_invocations.saturating_add(dropped);
        Ok(())
    }

    pub fn count(&mut self, mut row: Row, now: u64) -> Result<bool, Error> {
        let key = row.dimension()?;
        let daily = self.daily_counts.entry(row.day.clone()).or_default();
        if *daily >= policy::limits().max_daily_installation_count {
            self.dropped_invocations = self.dropped_invocations.saturating_add(1);
            return Ok(false);
        }
        if let Some(existing) = self.open.get_mut(&key) {
            if existing.count == policy::limits().max_row_count {
                self.dropped_invocations = self.dropped_invocations.saturating_add(1);
                return Ok(false);
            }
            existing.count += 1;
        } else {
            if self.open.len() >= policy::limits().max_local_dimensions {
                self.drop_oldest_open_day();
            }
            row.count = 1;
            self.open.insert(key, row.clone());
        }
        *self.daily_counts.entry(row.day).or_default() += 1;
        self.last_invocation_ms = now;
        self.next_close_ms
            .get_or_insert(now.saturating_add(policy::limits().upload_interval_seconds * 1000));
        Ok(true)
    }

    fn drop_oldest_open_day(&mut self) -> bool {
        let Some(day) = self.open.values().map(|r| &r.day).min().cloned() else {
            return false;
        };
        let mut dropped = 0u64;
        self.open.retain(|_, row| {
            if row.day == day {
                dropped = dropped.saturating_add(u64::from(row.count));
                false
            } else {
                true
            }
        });
        self.dropped_invocations = self.dropped_invocations.saturating_add(dropped);
        true
    }

    pub fn bound(&mut self) -> Result<(), Error> {
        while self.batches.len() > policy::limits().max_local_batches {
            let batch = self.batches.remove(0);
            self.dropped_invocations = self.dropped_invocations.saturating_add(batch.count);
        }
        loop {
            let oversized = serde_json::to_vec(self).map_err(|_| Error::State)?.len() as u64
                > policy::limits().max_local_bytes;
            if !oversized && self.batches.len() <= policy::limits().max_local_batches {
                return Ok(());
            }
            if !self.batches.is_empty() {
                let batch = self.batches.remove(0);
                self.dropped_invocations = self.dropped_invocations.saturating_add(batch.count);
            } else if !self.drop_oldest_open_day() {
                return Err(Error::State);
            }
        }
    }

    pub fn close(&mut self, tool: &str, now: u64) -> Result<(), Error> {
        let authority = self.authority.as_ref().ok_or(Error::State)?;
        let installation = authority.id.clone();
        while !self.open.is_empty() {
            let id = wire::uuid7(now)?;
            let mut rows = Vec::new();
            let mut keys = Vec::new();
            let mut count = 0;
            let mut bytes = wire::batch_body(tool, &installation, &id, &[])?.len();
            for (key, row) in &self.open {
                if rows.len() >= policy::limits().max_rows
                    || count + u64::from(row.count) > policy::limits().max_batch_count
                {
                    break;
                }
                let row_bytes =
                    wire::canonical(serde_json::to_value(row).map_err(|_| Error::State)?)?.len();
                let added_bytes = row_bytes + usize::from(!rows.is_empty());
                if bytes + added_bytes > policy::limits().max_batch_bytes {
                    break;
                }
                bytes += added_bytes;
                rows.push(row.clone());
                count += u64::from(row.count);
                keys.push(key.clone());
            }
            if rows.is_empty() {
                return Err(Error::State);
            }
            let body = wire::batch_body(tool, &installation, &id, &rows)?;
            let oldest_day = rows
                .iter()
                .map(|r| &r.day)
                .min()
                .ok_or(Error::State)?
                .clone();
            self.batches.push(Batch {
                id,
                hash: wire::sha256(body.as_bytes()),
                body,
                count,
                oldest_day,
                created_ms: now,
            });
            for key in keys {
                self.open.remove(&key);
            }
            self.bound()?;
        }
        self.next_close_ms =
            Some(now.saturating_add(policy::limits().upload_interval_seconds * 1000));
        Ok(())
    }

    pub fn validate(&self, tool: &str, mode: &str) -> Result<(), Error> {
        if self.open.len() > policy::limits().max_local_dimensions
            || self.batches.len() > policy::limits().max_local_batches
            || self.daily_counts.len() > 8
        {
            return Err(Error::State);
        }
        if let Some(grant) = &self.grant {
            if grant.revision != policy::CONSENT_REVISION {
                return Err(Error::State);
            }
            wire::timestamp(grant.at_ms)?;
        }
        if self.decision == Decision::Enabled && self.grant.is_none() {
            return Err(Error::State);
        }
        for (key, row) in &self.open {
            if !wire::valid_row(row, tool) || &row.dimension()? != key {
                return Err(Error::State);
            }
        }
        for (day, count) in &self.daily_counts {
            if !wire::valid_day(day) || *count > policy::limits().max_daily_installation_count {
                return Err(Error::State);
            }
        }
        if let Some(authority) = &self.authority {
            if wire::birth(&authority.id).is_none() || !wire::hex(&authority.token, 64) {
                return Err(Error::State);
            }
            if !authority.declaration.is_empty() {
                if !wire::valid_declaration(&authority.declaration, tool, mode) {
                    return Err(Error::State);
                }
            } else if self.decision == Decision::Enabled {
                return Err(Error::State);
            }
            for batch in &self.batches {
                if !wire::valid_batch(batch, tool, &authority.id) {
                    return Err(Error::State);
                }
            }
        } else if !self.batches.is_empty() || self.deletion == DeletionStatus::Pending {
            return Err(Error::State);
        }
        Ok(())
    }
}
