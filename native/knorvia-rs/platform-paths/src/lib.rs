//! Knorvia Home and logical directories.
//!
//! This crate is the only path resolver the rest of Knorvia may use for user
//! data. It never reads `CODEX_HOME` and never defaults to `~/.codex`.

use std::env;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

pub const KNORVIA_HOME_ENV: &str = "KNORVIA_HOME";
pub const CODEX_HOME_ENV: &str = "CODEX_HOME";
pub const PRODUCT_NAME: &str = "Knorvia";
pub const WINDOWS_DIR_NAME: &str = "Knorvia";
pub const UNIX_DIR_NAME: &str = "knorvia";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KnorviaPaths {
    pub home: PathBuf,
    pub config: PathBuf,
    pub state: PathBuf,
    pub artifacts: PathBuf,
    pub packs: PathBuf,
    pub cache: PathBuf,
    pub logs: PathBuf,
    pub run: PathBuf,
    pub backups: PathBuf,
    /// Private Kernel store. Upstream code may be pointed here via an
    /// injected `CODEX_HOME` that is **inside** Knorvia Home. It is not the
    /// user's official Codex home.
    pub kernel_store: PathBuf,
}

impl KnorviaPaths {
    /// Durable root for per-task working directories of threads that have no
    /// explicit project cwd. Created lazily when a directory is allocated, so
    /// Homes created before this feature stay byte-identical on ensure_layout.
    pub fn task_workspaces(&self) -> PathBuf {
        self.home.join("workspaces")
    }

    pub fn ensure_layout(&self) -> io::Result<()> {
        for dir in [
            &self.home,
            &self.config,
            &self.state,
            &self.artifacts,
            &self.packs,
            &self.cache,
            &self.logs,
            &self.run,
            &self.backups,
            &self.kernel_store,
        ] {
            fs::create_dir_all(dir)?;
        }
        Ok(())
    }
}

/// Resolve Knorvia Home.
///
/// Priority:
/// 1. explicit `home` argument
/// 2. `KNORVIA_HOME`
/// 3. platform application data directory
///
/// `CODEX_HOME` is ignored. `.codex` is never the default.
pub fn resolve(home: Option<&Path>) -> io::Result<KnorviaPaths> {
    let home = match home {
        Some(p) => expand_user(p),
        None => match env::var_os(KNORVIA_HOME_ENV) {
            Some(val) if !val.is_empty() => PathBuf::from(val),
            _ => default_home()?,
        },
    };
    Ok(layout(home))
}

pub fn layout(home: PathBuf) -> KnorviaPaths {
    KnorviaPaths {
        config: home.join("config"),
        state: home.join("state"),
        artifacts: home.join("artifacts"),
        packs: home.join("packs"),
        cache: home.join("cache"),
        logs: home.join("logs"),
        run: home.join("run"),
        backups: home.join("backups"),
        kernel_store: home.join("state").join("kernel"),
        home,
    }
}

pub fn default_home() -> io::Result<PathBuf> {
    if cfg!(windows) {
        let local = env::var_os("LOCALAPPDATA").ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                "LOCALAPPDATA is unset; cannot resolve Knorvia Home",
            )
        })?;
        Ok(PathBuf::from(local).join(WINDOWS_DIR_NAME))
    } else if cfg!(target_os = "macos") {
        Ok(user_home()?
            .join("Library/Application Support")
            .join(WINDOWS_DIR_NAME))
    } else {
        let xdg = env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or_else(|| user_home().expect("home").join(".local/share"));
        Ok(xdg.join(UNIX_DIR_NAME))
    }
}

fn user_home() -> io::Result<PathBuf> {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "HOME/USERPROFILE unset"))
}

fn expand_user(path: &Path) -> PathBuf {
    let raw = path.as_os_str();
    let s = raw.to_string_lossy();
    if let Some(rest) = s.strip_prefix("~/") {
        if let Ok(home) = user_home() {
            return home.join(rest);
        }
    }
    path.to_path_buf()
}

/// True if `path` is inside an official Codex home (`.codex` or `CODEX_HOME`).
/// Used by coexistence tests and as a hard deny for default writes.
pub fn is_codex_path(path: &Path) -> bool {
    let hay = path.to_string_lossy();
    if hay.contains(".codex") {
        return true;
    }
    if let Some(codex_home) = env::var_os(CODEX_HOME_ENV) {
        let ch = PathBuf::from(codex_home);
        if !ch.as_os_str().is_empty() && path.starts_with(&ch) {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    struct EnvGuard {
        key: &'static str,
        old: Option<OsString>,
    }

    impl EnvGuard {
        fn set(key: &'static str, val: &str) -> Self {
            let old = env::var_os(key);
            // SAFETY: tests serialize env mutations with ENV_LOCK.
            unsafe { env::set_var(key, val) };
            Self { key, old }
        }

        fn unset(key: &'static str) -> Self {
            let old = env::var_os(key);
            unsafe { env::remove_var(key) };
            Self { key, old }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            unsafe {
                match &self.old {
                    Some(v) => env::set_var(self.key, v),
                    None => env::remove_var(self.key),
                }
            }
        }
    }

    fn temp_dir() -> PathBuf {
        let base = env::temp_dir().join(format!(
            "knorvia-paths-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&base).unwrap();
        base
    }

    #[test]
    fn knorvia_home_env_wins_and_ignores_codex_home() {
        let _lock = ENV_LOCK.lock().unwrap();
        let kn = temp_dir();
        let cx = temp_dir();
        let _g1 = EnvGuard::set(KNORVIA_HOME_ENV, kn.to_str().unwrap());
        let _g2 = EnvGuard::set(CODEX_HOME_ENV, cx.to_str().unwrap());
        let paths = resolve(None).unwrap();
        assert_eq!(paths.home, kn);
        assert!(!paths.home.starts_with(&cx));
        assert!(!is_codex_path(&paths.home));
        assert!(!is_codex_path(&paths.kernel_store));
        assert!(paths.kernel_store.starts_with(&kn));
        let _ = fs::remove_dir_all(kn);
        let _ = fs::remove_dir_all(cx);
    }

    #[test]
    fn explicit_home_beats_env() {
        let _lock = ENV_LOCK.lock().unwrap();
        let kn = temp_dir();
        let other = temp_dir();
        let _g1 = EnvGuard::set(KNORVIA_HOME_ENV, kn.to_str().unwrap());
        let paths = resolve(Some(&other)).unwrap();
        assert_eq!(paths.home, other);
        let _ = fs::remove_dir_all(kn);
        let _ = fs::remove_dir_all(other);
    }

    #[test]
    fn default_home_is_not_dot_codex() {
        let _lock = ENV_LOCK.lock().unwrap();
        let _g1 = EnvGuard::unset(KNORVIA_HOME_ENV);
        let _g2 = EnvGuard::unset(CODEX_HOME_ENV);
        let home = default_home().unwrap();
        let home_s = home.to_string_lossy();
        assert!(
            !home_s.contains(".codex"),
            "default home leaked Codex path: {home_s}"
        );
        assert!(
            home_s.contains("Knorvia") || home_s.contains("knorvia"),
            "default home is not a Knorvia directory: {home_s}"
        );
    }

    #[test]
    fn ensure_layout_creates_logical_dirs_only_under_home() {
        let _lock = ENV_LOCK.lock().unwrap();
        let kn = temp_dir();
        let _g1 = EnvGuard::unset(KNORVIA_HOME_ENV);
        let paths = resolve(Some(&kn)).unwrap();
        paths.ensure_layout().unwrap();
        for dir in [
            &paths.config,
            &paths.state,
            &paths.artifacts,
            &paths.packs,
            &paths.cache,
            &paths.logs,
            &paths.run,
            &paths.backups,
            &paths.kernel_store,
        ] {
            assert!(dir.is_dir(), "missing {dir:?}");
            assert!(dir.starts_with(&kn));
        }
        let _ = fs::remove_dir_all(kn);
    }

    #[test]
    fn is_codex_path_detects_dot_codex() {
        assert!(is_codex_path(Path::new(r"C:\Users\me\.codex\config.toml")));
        assert!(!is_codex_path(Path::new(
            r"C:\Users\me\AppData\Local\Knorvia\config"
        )));
    }
}
