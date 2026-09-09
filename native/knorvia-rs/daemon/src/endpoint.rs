//! Owner-only discovery credentials for a loopback transport. The Home lock,
//! not this replaceable discovery file, determines who may mutate the store.
use knorvia_platform_paths::KnorviaPaths;
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{self, Write};
use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize)]
pub(crate) struct Endpoint {
    pub version: u32,
    pub port: u16,
    pub pid: u32,
    pub token: String,
}

impl Endpoint {
    pub fn address(&self) -> SocketAddr {
        SocketAddr::from((Ipv4Addr::LOCALHOST, self.port))
    }

    pub fn read(paths: &KnorviaPaths) -> io::Result<Self> {
        let file = paths.run.join("shared-owner.json");
        if fs::metadata(&file)?.len() > 4096 {
            return Err(io::Error::other("invalid owner discovery"));
        }
        let endpoint: Self = serde_json::from_slice(&fs::read(file)?)?;
        if endpoint.version != 1 || endpoint.token.len() != 64 || endpoint.port == 0 {
            return Err(io::Error::other("unsupported owner discovery"));
        }
        Ok(endpoint)
    }
}

pub(crate) struct PublishedEndpoint {
    path: PathBuf,
    pub endpoint: Endpoint,
}

impl PublishedEndpoint {
    pub fn publish(paths: &KnorviaPaths, port: u16) -> io::Result<Self> {
        let mut token = [0_u8; 32];
        getrandom::getrandom(&mut token)
            .map_err(|_| io::Error::other("OS randomness unavailable"))?;
        let endpoint = Endpoint {
            version: 1,
            port,
            pid: std::process::id(),
            token: hex::encode(token),
        };
        let path = paths.run.join("shared-owner.json");
        let temporary = paths.run.join(format!("shared-owner-{}.tmp", endpoint.pid));
        let mut file = private_file(&temporary)?;
        file.write_all(&serde_json::to_vec(&endpoint)?)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, &path)?;
        Ok(Self { path, endpoint })
    }
}

impl Drop for PublishedEndpoint {
    fn drop(&mut self) {
        // Called while the owner still holds its OS lock. Never delete lock files.
        let _ = fs::remove_file(&self.path);
    }
}

#[cfg(unix)]
fn private_file(path: &Path) -> io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
}

#[cfg(windows)]
fn private_file(path: &Path) -> io::Result<File> {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::FromRawHandle;
    use windows_sys::Win32::Foundation::{GENERIC_WRITE, INVALID_HANDLE_VALUE, LocalFree};
    use windows_sys::Win32::Security::Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW;
    use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
    use windows_sys::Win32::Storage::FileSystem::{CREATE_NEW, CreateFileW, FILE_ATTRIBUTE_NORMAL};
    let name: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    // Protected DACL: only the file owner. Do not inherit broad workspace ACLs.
    let sddl: Vec<u16> = "D:P(A;;FA;;;OW)\0".encode_utf16().collect();
    let mut descriptor = std::ptr::null_mut();
    // SAFETY: terminated UTF-16 inputs; descriptor is freed after CreateFileW.
    unsafe {
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            1,
            &mut descriptor,
            std::ptr::null_mut(),
        ) == 0
        {
            return Err(io::Error::last_os_error());
        }
        let attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor,
            bInheritHandle: 0,
        };
        let handle = CreateFileW(
            name.as_ptr(),
            GENERIC_WRITE,
            0,
            &attributes,
            CREATE_NEW,
            FILE_ATTRIBUTE_NORMAL,
            std::ptr::null_mut(),
        );
        let error = io::Error::last_os_error();
        LocalFree(descriptor);
        if handle == INVALID_HANDLE_VALUE {
            return Err(error);
        }
        Ok(File::from_raw_handle(handle))
    }
}
