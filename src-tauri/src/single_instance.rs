use std::{
    env, fs,
    io::{self, Write},
    path::{Path, PathBuf},
};

const LOCK_FILE_NAME: &str = "classic-radio.lock";

pub struct InstanceLock {
    path: PathBuf,
}

#[derive(Debug)]
pub enum AcquireError {
    AlreadyRunning { mode: String, pid: u32 },
    Io(io::Error),
}

impl std::fmt::Display for AcquireError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AcquireError::AlreadyRunning { mode, pid } => write!(
                f,
                "Classic Radio sudah berjalan dalam mode {mode} (PID {pid}). Tutup instance itu dulu sebelum menjalankan yang baru."
            ),
            AcquireError::Io(error) => write!(f, "Gagal membuat lockfile: {error}"),
        }
    }
}

impl InstanceLock {
    pub fn acquire(mode: &str) -> Result<Self, AcquireError> {
        let path = lock_path();
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }

        for _ in 0..2 {
            match fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
            {
                Ok(mut file) => {
                    writeln!(file, "{mode} {}", std::process::id()).map_err(AcquireError::Io)?;
                    return Ok(Self { path });
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    if let Some((other_mode, other_pid)) = read_owner(&path) {
                        if process_alive(other_pid) {
                            return Err(AcquireError::AlreadyRunning {
                                mode: other_mode,
                                pid: other_pid,
                            });
                        }
                    }
                    let _ = fs::remove_file(&path);
                }
                Err(error) => return Err(AcquireError::Io(error)),
            }
        }

        Err(AcquireError::Io(io::Error::new(
            io::ErrorKind::Other,
            "tidak bisa mengambil lock setelah membersihkan lock basi",
        )))
    }
}

impl Drop for InstanceLock {
    fn drop(&mut self) {
        if let Some((_, pid)) = read_owner(&self.path) {
            if pid == std::process::id() {
                let _ = fs::remove_file(&self.path);
            }
        }
    }
}

fn lock_path() -> PathBuf {
    if let Some(dir) = env::var_os("XDG_RUNTIME_DIR") {
        return PathBuf::from(dir).join(LOCK_FILE_NAME);
    }
    let uid = unsafe { libc_getuid() };
    env::temp_dir().join(format!("classic-radio-{uid}.lock"))
}

fn read_owner(path: &Path) -> Option<(String, u32)> {
    let content = fs::read_to_string(path).ok()?;
    let mut parts = content.split_whitespace();
    let mode = parts.next()?.to_string();
    let pid: u32 = parts.next()?.parse().ok()?;
    Some((mode, pid))
}

fn process_alive(pid: u32) -> bool {
    Path::new(&format!("/proc/{pid}")).exists()
}

#[cfg(target_os = "linux")]
extern "C" {
    #[link_name = "getuid"]
    fn libc_getuid() -> u32;
}

#[cfg(not(target_os = "linux"))]
unsafe fn libc_getuid() -> u32 {
    0
}
