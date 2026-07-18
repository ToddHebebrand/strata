use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::Path;

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use strata_kernel::IntentRecord;

use super::protocol::{LocalServiceRequest, LocalServiceResponse, RequestAction};

const ZERO_HASH: &str = "0000000000000000000000000000000000000000000000000000000000000000";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct PendingRequest {
    pub identity: String,
    pub client_id: String,
    pub idempotency_key: String,
    pub body_hash: String,
    pub tick: u64,
    pub action: RequestAction,
    pub baseline_intents: Vec<IntentRecord>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum JournalRecord {
    RequestBound {
        request_hash: String,
        body_hash: String,
    },
    Pending {
        request: PendingRequest,
    },
    EffectResult {
        identity: String,
        body_hash: String,
        response: LocalServiceResponse,
        follow_up: Option<FollowUp>,
    },
    Completed {
        identity: String,
        body_hash: String,
        response: LocalServiceResponse,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum FollowUp {
    CancelChangeSet { change_set_id: String, tick: u64 },
}

#[derive(Clone, Debug)]
pub(super) enum RequestLedgerEntry {
    Pending(PendingRequest),
    EffectResult {
        body_hash: String,
        response: LocalServiceResponse,
        follow_up: Option<FollowUp>,
    },
    Completed {
        body_hash: String,
        response: LocalServiceResponse,
    },
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct JournalLine {
    previous_hash: String,
    entry_hash: String,
    record: JournalRecord,
}

pub(super) struct RequestJournal {
    file: File,
    previous_hash: String,
    entries: BTreeMap<String, RequestLedgerEntry>,
    request_bindings: BTreeMap<String, String>,
    max_tick: u64,
}

impl RequestJournal {
    pub fn open(path: &Path) -> Result<Self> {
        let (mut file, lines, previous_hash) = open_and_validate_lines(path, |line| {
            let parsed: JournalLine = serde_json::from_slice(line)?;
            let encoded = serde_json::to_vec(&parsed.record)?;
            verify_hash(&parsed.previous_hash, &parsed.entry_hash, &encoded)?;
            Ok((parsed.previous_hash, parsed.entry_hash, parsed.record))
        })?;
        let mut entries = BTreeMap::new();
        let mut request_bindings = BTreeMap::new();
        let mut max_tick = 0;
        for (_, _, record) in lines {
            match record {
                JournalRecord::RequestBound {
                    request_hash,
                    body_hash,
                } => {
                    if request_bindings
                        .insert(request_hash, body_hash.clone())
                        .is_some_and(|previous| previous != body_hash)
                    {
                        bail!("request ID hash was rebound to a different body");
                    }
                }
                JournalRecord::Pending { request } => {
                    max_tick = max_tick.max(request.tick);
                    entries.insert(
                        request.identity.clone(),
                        RequestLedgerEntry::Pending(request),
                    );
                }
                JournalRecord::EffectResult {
                    identity,
                    body_hash,
                    response,
                    follow_up,
                } => {
                    entries.insert(
                        identity,
                        RequestLedgerEntry::EffectResult {
                            body_hash,
                            response,
                            follow_up,
                        },
                    );
                }
                JournalRecord::Completed {
                    identity,
                    body_hash,
                    response,
                } => {
                    entries.insert(
                        identity,
                        RequestLedgerEntry::Completed {
                            body_hash,
                            response,
                        },
                    );
                }
            }
        }
        file.seek(SeekFrom::End(0))?;
        Ok(Self {
            file,
            previous_hash,
            entries,
            request_bindings,
            max_tick,
        })
    }

    pub fn max_tick(&self) -> u64 {
        self.max_tick
    }

    pub fn entries(&self) -> &BTreeMap<String, RequestLedgerEntry> {
        &self.entries
    }

    pub fn entry(&self, identity: &str) -> Option<&RequestLedgerEntry> {
        self.entries.get(identity)
    }

    pub fn bind_request(&mut self, request: &LocalServiceRequest) -> Result<bool> {
        let request_hash = client_hash(&request.request_id);
        let body_hash = request_body_hash(request)?;
        if let Some(previous) = self.request_bindings.get(&request_hash) {
            return Ok(previous == &body_hash);
        }
        self.append(JournalRecord::RequestBound {
            request_hash: request_hash.clone(),
            body_hash: body_hash.clone(),
        })?;
        self.request_bindings.insert(request_hash, body_hash);
        Ok(true)
    }

    pub fn append_pending(&mut self, request: PendingRequest) -> Result<()> {
        self.max_tick = self.max_tick.max(request.tick);
        self.append(JournalRecord::Pending {
            request: request.clone(),
        })?;
        self.entries.insert(
            request.identity.clone(),
            RequestLedgerEntry::Pending(request),
        );
        Ok(())
    }

    pub fn append_completed(
        &mut self,
        identity: String,
        body_hash: String,
        response: LocalServiceResponse,
    ) -> Result<()> {
        self.append(JournalRecord::Completed {
            identity: identity.clone(),
            body_hash: body_hash.clone(),
            response: response.clone(),
        })?;
        self.entries.insert(
            identity,
            RequestLedgerEntry::Completed {
                body_hash,
                response,
            },
        );
        Ok(())
    }

    pub fn append_effect_result(
        &mut self,
        identity: String,
        body_hash: String,
        response: LocalServiceResponse,
        follow_up: Option<FollowUp>,
    ) -> Result<()> {
        self.append(JournalRecord::EffectResult {
            identity: identity.clone(),
            body_hash: body_hash.clone(),
            response: response.clone(),
            follow_up: follow_up.clone(),
        })?;
        self.entries.insert(
            identity,
            RequestLedgerEntry::EffectResult {
                body_hash,
                response,
                follow_up,
            },
        );
        Ok(())
    }

    fn append(&mut self, record: JournalRecord) -> Result<()> {
        let encoded = serde_json::to_vec(&record)?;
        let entry_hash = chained_hash(&self.previous_hash, &encoded);
        let line = JournalLine {
            previous_hash: self.previous_hash.clone(),
            entry_hash: entry_hash.clone(),
            record,
        };
        serde_json::to_writer(&mut self.file, &line)?;
        self.file.write_all(b"\n")?;
        self.file
            .sync_data()
            .context("fsync service request journal")?;
        self.previous_hash = entry_hash;
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct AuditEvent {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tick: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub change_set_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    pub graph_generation: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AuditLine {
    previous_hash: String,
    entry_hash: String,
    event: AuditEvent,
}

pub(super) struct ServiceAudit {
    file: File,
    previous_hash: String,
}

impl ServiceAudit {
    pub fn open(path: &Path) -> Result<Self> {
        let (mut file, _, previous_hash) = open_and_validate_lines(path, |line| {
            let parsed: AuditLine = serde_json::from_slice(line)?;
            let encoded = serde_json::to_vec(&serde_json::to_value(&parsed.event)?)?;
            verify_hash(&parsed.previous_hash, &parsed.entry_hash, &encoded)?;
            Ok((parsed.previous_hash, parsed.entry_hash, ()))
        })?;
        file.seek(SeekFrom::End(0))?;
        Ok(Self {
            file,
            previous_hash,
        })
    }

    pub fn append(&mut self, event: AuditEvent) -> Result<()> {
        let encoded = serde_json::to_vec(&serde_json::to_value(&event)?)?;
        let entry_hash = chained_hash(&self.previous_hash, &encoded);
        let line = AuditLine {
            previous_hash: self.previous_hash.clone(),
            entry_hash: entry_hash.clone(),
            event,
        };
        serde_json::to_writer(&mut self.file, &line)?;
        self.file.write_all(b"\n")?;
        self.file.sync_data().context("fsync service audit")?;
        self.previous_hash = entry_hash;
        Ok(())
    }
}

pub(super) fn request_identity(client_id: &str, idempotency_key: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(client_id.as_bytes());
    hasher.update([0]);
    hasher.update(idempotency_key.as_bytes());
    format!("{:x}", hasher.finalize())
}

pub(super) fn client_hash(client_id: &str) -> String {
    format!("{:x}", Sha256::digest(client_id.as_bytes()))
}

pub(super) fn action_body_hash(client_id: &str, action: &RequestAction) -> Result<String> {
    let mut hasher = Sha256::new();
    hasher.update(client_id.as_bytes());
    hasher.update([0]);
    hasher.update(serde_json::to_vec(action)?);
    Ok(format!("{:x}", hasher.finalize()))
}

fn request_body_hash(request: &LocalServiceRequest) -> Result<String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(request)?)
    ))
}

fn chained_hash(previous_hash: &str, encoded: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(previous_hash.as_bytes());
    hasher.update(encoded);
    format!("{:x}", hasher.finalize())
}

fn verify_hash(previous_hash: &str, entry_hash: &str, encoded: &[u8]) -> Result<()> {
    if entry_hash != chained_hash(previous_hash, encoded) {
        bail!("service journal hash chain is invalid");
    }
    Ok(())
}

type ValidatedLines<T> = (File, Vec<(String, String, T)>, String);

fn open_and_validate_lines<T>(
    path: &Path,
    mut decode: impl FnMut(&[u8]) -> Result<(String, String, T)>,
) -> Result<ValidatedLines<T>> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .mode(0o600)
        .read(true)
        .write(true)
        .open(path)
        .with_context(|| format!("open service journal {}", path.display()))?;
    file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    let mut valid_len = 0_u64;
    let mut previous = ZERO_HASH.to_owned();
    let mut decoded = Vec::new();
    for part in bytes.split_inclusive(|byte| *byte == b'\n') {
        if part.last() != Some(&b'\n') {
            file.set_len(valid_len)?;
            file.sync_data()?;
            break;
        }
        let line = &part[..part.len() - 1];
        if line.is_empty() {
            bail!("service journal contains an empty record");
        }
        let (record_previous, entry_hash, value) = decode(line)
            .with_context(|| format!("invalid complete service journal record at {valid_len}"))?;
        if record_previous != previous {
            bail!("service journal previous hash is invalid");
        }
        previous = entry_hash.clone();
        decoded.push((record_previous, entry_hash, value));
        valid_len += part.len() as u64;
    }
    Ok((file, decoded, previous))
}
