//! Disposable fixed-width offsets, authenticated only for this store lifetime.
//! A cold index is built in bounded slices; WAL recovery remains authoritative.
use super::{ProductStore, ProtocolError, StoreError, event_id};
use knorvia_protocol::ErrorCategory;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant, SystemTime};

pub(super) const BUILD_BYTES: usize = 1024 * 1024;
const RECORD_BYTES: u64 = 48;
const MAX_CACHED_STREAMS: usize = 64;

#[derive(Debug, Default)]
pub(super) struct ReplayIndexes(pub HashMap<String, IndexState>);

#[derive(Debug)]
pub(super) struct IndexState {
    key: String,
    scanned: u64,
    line_start: u64,
    count: u64,
    modified: Option<SystemTime>,
}

fn signature(key: &str, seq: u64, offset: u64, length: u64) -> [u8; 32] {
    let mut hash = Sha256::new();
    hash.update(key.as_bytes());
    hash.update(seq.to_le_bytes());
    hash.update(offset.to_le_bytes());
    hash.update(length.to_le_bytes());
    hash.finalize().into()
}

impl ProductStore {
    pub(super) fn replay_index_path(&self, stream: &str) -> std::path::PathBuf {
        self.paths
            .state
            .join("events")
            .join(format!("{stream}.jsonl.idx"))
    }

    pub(super) fn prepare_replay_index(&self, stream: &str, upper: u64) -> Result<(), StoreError> {
        let mut indexes = self
            .locks
            .replay_indexes
            .lock()
            .map_err(|_| StoreError::Corrupt("replay index lock poisoned".into()))?;
        let path = self.replay_index_path(stream);
        let metadata = fs::metadata(&path).ok();
        let valid = indexes.0.get(stream).is_some_and(|state| {
            metadata.as_ref().is_some_and(|meta| {
                Some(meta.len()) == state.count.checked_mul(RECORD_BYTES)
                    && meta.modified().ok() == state.modified
            })
        });
        if !valid {
            if indexes.0.len() >= MAX_CACHED_STREAMS {
                indexes.0.clear();
            }
            // The existing sidecar is never an authority, including after restart.
            let file = File::create(&path)?;
            indexes.0.insert(
                stream.to_owned(),
                IndexState {
                    key: event_id(),
                    scanned: 0,
                    line_start: 0,
                    count: 0,
                    modified: file.metadata()?.modified().ok(),
                },
            );
        }
        let state = indexes.0.get_mut(stream).expect("inserted");
        if state.count >= upper {
            return Ok(());
        }
        let mut journal = File::open(self.events_path(stream))?;
        journal.seek(SeekFrom::Start(state.scanned))?;
        let mut output = OpenOptions::new().append(true).open(&path)?;
        let deadline = Instant::now() + Duration::from_millis(25);
        let mut scanned = 0;
        let mut buffer = [0u8; 32 * 1024];
        while scanned < BUILD_BYTES && Instant::now() < deadline && state.count < upper {
            let n = journal.read(&mut buffer[..(BUILD_BYTES - scanned).min(32 * 1024)])?;
            if n == 0 {
                break;
            }
            scanned += n;
            self.locks
                .page_bytes_read
                .fetch_add(n as u64, Ordering::Relaxed);
            for (position, byte) in buffer[..n].iter().enumerate() {
                if *byte != b'\n' {
                    continue;
                }
                let end = state
                    .scanned
                    .checked_add(position as u64 + 1)
                    .ok_or_else(|| StoreError::Corrupt("journal offset overflow".into()))?;
                let length = end
                    .checked_sub(state.line_start)
                    .ok_or_else(|| StoreError::Corrupt("journal range overflow".into()))?;
                state.count = state
                    .count
                    .checked_add(1)
                    .ok_or_else(|| StoreError::Corrupt("journal sequence overflow".into()))?;
                output.write_all(&state.line_start.to_le_bytes())?;
                output.write_all(&length.to_le_bytes())?;
                output.write_all(&signature(
                    &state.key,
                    state.count,
                    state.line_start,
                    length,
                ))?;
                state.line_start = end;
            }
            state.scanned += n as u64;
        }
        output.flush()?;
        state.modified = output.metadata()?.modified().ok();
        if state.count < upper {
            if state.scanned >= journal.metadata()?.len() {
                return Err(StoreError::Corrupt(
                    "recovered journal count disagrees with replay offsets".into(),
                ));
            }
            return Err(ProtocolError::new(ErrorCategory::ResourceExhausted, format!(
                "replay_index_building: indexedSeq={}, upperSeq={}, scannedBytes={}; retry the same cursor", state.count, upper, state.scanned
            )).into());
        }
        Ok(())
    }

    pub(super) fn replay_offset(&self, stream: &str, seq: u64) -> Result<(u64, u64), StoreError> {
        let indexes = self
            .locks
            .replay_indexes
            .lock()
            .map_err(|_| StoreError::Corrupt("replay index lock poisoned".into()))?;
        let state = indexes
            .0
            .get(stream)
            .ok_or_else(|| StoreError::Corrupt("replay index absent".into()))?;
        if seq == 0 || seq > state.count {
            return Err(StoreError::Corrupt(
                "replay index sequence outside coverage".into(),
            ));
        }
        let mut file = File::open(self.replay_index_path(stream))?;
        file.seek(SeekFrom::Start(
            (seq - 1)
                .checked_mul(RECORD_BYTES)
                .ok_or_else(|| StoreError::Corrupt("index offset overflow".into()))?,
        ))?;
        let mut raw = [0; RECORD_BYTES as usize];
        file.read_exact(&mut raw)?;
        self.locks
            .page_bytes_read
            .fetch_add(RECORD_BYTES, Ordering::Relaxed);
        let offset = u64::from_le_bytes(raw[..8].try_into().expect("eight bytes"));
        let length = u64::from_le_bytes(raw[8..16].try_into().expect("eight bytes"));
        if raw[16..] != signature(&state.key, seq, offset, length)
            || length == 0
            || offset
                .checked_add(length)
                .is_none_or(|end| end > state.scanned)
            || (seq == 1 && offset != 0)
        {
            return Err(StoreError::Corrupt(
                "replay index signature or contiguous range is invalid".into(),
            ));
        }
        Ok((offset, length))
    }
}
