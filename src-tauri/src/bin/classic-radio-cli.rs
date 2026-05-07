use classic_radio_lib::single_instance::InstanceLock;
use serde::Deserialize;
use std::{
    collections::VecDeque,
    env, fs,
    io::{self, Read, Write},
    os::unix::net::UnixStream,
    path::PathBuf,
    process::{Child, Command, ExitStatus, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, RecvTimeoutError},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

const STATIONS_JSON: &str = include_str!("../../resources/stations.json");
const PAGE_SIZE: usize = 12;
const DEFAULT_VOLUME: u8 = 80;

const ANIM_FRAMES: &[&str] = &[
    "▂▄▆█▆▄▂▄▆█▆▄",
    "▄▆█▆▄▂▄▆█▆▄▂",
    "▆█▆▄▂▄▆█▆▄▂▄",
    "█▆▄▂▄▆█▆▄▂▄▆",
    "▆▄▂▄▆█▆▄▂▄▆█",
    "▄▂▄▆█▆▄▂▄▆█▆",
];
const ANIM_INTERVAL_MS: u64 = 110;
const MPV_STDERR_TAIL_BYTES: usize = 12 * 1024;
const PLAYBACK_POLL_INTERVAL: Duration = Duration::from_millis(500);
const RECONNECT_MAX_DELAY: Duration = Duration::from_secs(15);
const RECONNECT_MAX_ATTEMPTS: u32 = 10;

const CLEAR: &str = "\x1b[2J\x1b[H";
const ENTER_ALT_SCREEN: &str = "\x1b[?1049h\x1b[?1007l\x1b[H\x1b[?25h";
const EXIT_ALT_SCREEN: &str = "\x1b[?1007h\x1b[?1049l";
const NOW_PLAYING_ROW: usize = 3;
const RESET: &str = "\x1b[0m";
const BOLD: &str = "\x1b[1m";
const DIM: &str = "\x1b[2m";
const GREEN: &str = "\x1b[32m";
const YELLOW: &str = "\x1b[33m";
const CYAN: &str = "\x1b[36m";
const RED: &str = "\x1b[31m";
const GREY: &str = "\x1b[90m";

#[derive(Debug, Deserialize, Clone)]
struct Station {
    name: String,
    url: String,
    #[serde(default)]
    country: String,
    #[serde(default)]
    source: String,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum SourceFilter {
    All,
    Indonesia,
    International,
}

impl SourceFilter {
    fn label(self) -> &'static str {
        match self {
            SourceFilter::All => "Semua",
            SourceFilter::Indonesia => "Indonesia",
            SourceFilter::International => "International",
        }
    }

    fn matches(self, station: &Station) -> bool {
        match self {
            SourceFilter::All => true,
            SourceFilter::Indonesia => station.source.eq_ignore_ascii_case("Indonesia"),
            SourceFilter::International => station.source.eq_ignore_ascii_case("International"),
        }
    }
}

struct Player {
    child: Option<Child>,
    socket_path: Option<PathBuf>,
    stderr_tail: Arc<Mutex<VecDeque<u8>>>,
    stderr_reader: Option<JoinHandle<()>>,
    paused: bool,
    muted: bool,
    volume: u8,
}

impl Player {
    fn new() -> Self {
        Self {
            child: None,
            socket_path: None,
            stderr_tail: Arc::new(Mutex::new(VecDeque::new())),
            stderr_reader: None,
            paused: false,
            muted: false,
            volume: DEFAULT_VOLUME,
        }
    }

    fn is_active(&self) -> bool {
        self.child.is_some()
    }

    fn play(&mut self, station: &Station) -> io::Result<()> {
        self.stop();

        let socket_path = make_socket_path();
        let _ = fs::remove_file(&socket_path);

        let mute_arg = if self.muted {
            "--mute=yes"
        } else {
            "--mute=no"
        };
        let volume_arg = format!("--volume={}", self.volume);
        let ipc_arg = format!("--input-ipc-server={}", socket_path.display());

        self.reset_stderr_tail();

        let mut child = Command::new("mpv")
            .args([
                "--no-video",
                "--force-window=no",
                "--idle=no",
                &ipc_arg,
                &volume_arg,
                mute_arg,
                &station.url,
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()?;

        if let Some(stderr) = child.stderr.take() {
            self.stderr_reader = Some(spawn_stderr_reader(stderr, self.stderr_tail.clone()));
        }

        self.child = Some(child);
        self.socket_path = Some(socket_path);
        self.paused = false;
        Ok(())
    }

    fn stop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        self.join_stderr_reader();
        if let Some(path) = self.socket_path.take() {
            let _ = fs::remove_file(path);
        }
        self.paused = false;
    }

    fn ipc_set(&mut self, property: &str, value: &str) -> Result<(), String> {
        self.ensure_mpv_running()?;

        let path = self
            .socket_path
            .clone()
            .ok_or_else(|| "mpv tidak sedang berjalan".to_string())?;

        for _ in 0..40 {
            if path.exists() {
                break;
            }
            self.ensure_mpv_running()?;
            thread::sleep(Duration::from_millis(50));
        }

        self.ensure_mpv_running()?;

        let mut stream = UnixStream::connect(&path)
            .map_err(|error| format!("Gagal terhubung ke IPC mpv: {error}"))?;
        let line = format!(r#"{{"command":["set_property","{}",{}]}}"#, property, value);
        stream
            .write_all(line.as_bytes())
            .map_err(|error| format!("Gagal kirim perintah ke mpv: {error}"))?;
        stream
            .write_all(b"\n")
            .map_err(|error| format!("Gagal kirim perintah ke mpv: {error}"))?;
        Ok(())
    }

    fn ensure_mpv_running(&mut self) -> Result<(), String> {
        let status = match self.child.as_mut() {
            Some(child) => child
                .try_wait()
                .map_err(|error| format!("Gagal memeriksa status mpv: {error}"))?,
            None => return Err("mpv tidak sedang berjalan".into()),
        };

        if let Some(status) = status {
            return Err(self.handle_mpv_exit(status));
        }

        Ok(())
    }

    fn poll_exit(&mut self) -> Option<String> {
        match self.child.as_mut()?.try_wait() {
            Ok(Some(status)) => Some(self.handle_mpv_exit(status)),
            Ok(None) => None,
            Err(error) => Some(format!("Gagal memeriksa status mpv: {error}")),
        }
    }

    fn handle_mpv_exit(&mut self, status: ExitStatus) -> String {
        self.child = None;
        self.join_stderr_reader();
        if let Some(path) = self.socket_path.take() {
            let _ = fs::remove_file(path);
        }
        self.paused = false;

        let stderr = self.stderr_tail_text();
        self.reset_stderr_tail();

        if stderr.is_empty() {
            format!("mpv berhenti sebelum siap menerima perintah IPC (status: {status})")
        } else {
            format!(
                "mpv berhenti sebelum siap menerima perintah IPC (status: {status}). Error mpv: {stderr}"
            )
        }
    }

    fn reset_stderr_tail(&self) {
        if let Ok(mut tail) = self.stderr_tail.lock() {
            tail.clear();
        }
    }

    fn stderr_tail_text(&self) -> String {
        let bytes = match self.stderr_tail.lock() {
            Ok(tail) => tail.iter().copied().collect::<Vec<_>>(),
            Err(_) => return String::new(),
        };
        String::from_utf8_lossy(&bytes).trim().to_string()
    }

    fn join_stderr_reader(&mut self) {
        if let Some(handle) = self.stderr_reader.take() {
            let _ = handle.join();
        }
    }

    fn toggle_pause(&mut self) -> Result<(), String> {
        if !self.is_active() {
            return Err("Belum ada stasiun yang diputar.".into());
        }
        let new_state = !self.paused;
        self.ipc_set("pause", if new_state { "true" } else { "false" })
            .map_err(|error| format!("Gagal kirim perintah pause: {error}"))?;
        self.paused = new_state;
        Ok(())
    }

    fn toggle_mute(&mut self) -> Result<(), String> {
        let new_state = !self.muted;
        if self.is_active() {
            self.ipc_set("mute", if new_state { "true" } else { "false" })
                .map_err(|error| format!("Gagal kirim perintah mute: {error}"))?;
        }
        self.muted = new_state;
        Ok(())
    }

    fn set_volume(&mut self, volume: u8) -> Result<(), String> {
        let clamped = volume.min(100);
        if self.is_active() {
            self.ipc_set("volume", &clamped.to_string())
                .map_err(|error| format!("Gagal kirim perintah volume: {error}"))?;
        }
        self.volume = clamped;
        Ok(())
    }

    fn adjust_volume(&mut self, delta: i32) -> Result<(), String> {
        let next = (self.volume as i32 + delta).clamp(0, 100) as u8;
        self.set_volume(next)
    }
}

fn spawn_stderr_reader(
    mut stderr: impl Read + Send + 'static,
    tail: Arc<Mutex<VecDeque<u8>>>,
) -> JoinHandle<()> {
    thread::spawn(move || {
        let mut buffer = [0u8; 1024];
        loop {
            match stderr.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => {
                    if let Ok(mut tail) = tail.lock() {
                        for byte in &buffer[..read] {
                            if tail.len() == MPV_STDERR_TAIL_BYTES {
                                tail.pop_front();
                            }
                            tail.push_back(*byte);
                        }
                    }
                }
                Err(_) => break,
            }
        }
    })
}

fn spawn_input_reader() -> mpsc::Receiver<String> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || loop {
        let mut input = String::new();
        match io::stdin().read_line(&mut input) {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                if tx.send(input).is_err() {
                    break;
                }
            }
        }
    });
    rx
}

fn reconnect_delay(attempt: u32) -> Duration {
    let exponent = attempt.saturating_sub(1).min(4);
    let secs = 2u64.pow(exponent).min(RECONNECT_MAX_DELAY.as_secs());
    Duration::from_secs(secs)
}

impl Drop for Player {
    fn drop(&mut self) {
        self.stop();
    }
}

struct Spinner {
    running: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl Spinner {
    fn start(output_lock: Arc<Mutex<()>>, label: String) -> Self {
        let running = Arc::new(AtomicBool::new(true));
        let flag = running.clone();
        let handle = thread::spawn(move || {
            let mut idx = 0usize;
            while flag.load(Ordering::Relaxed) {
                {
                    let _guard = output_lock.lock().unwrap();
                    print!(
                        "\x1b7\x1b[{NOW_PLAYING_ROW};1H\x1b[2K Now playing : {GREEN}♪{RESET}  {CYAN}{}{RESET}  {BOLD}{RED}● LIVE{RESET}  {GREEN}{}{RESET}\x1b8",
                        ANIM_FRAMES[idx], label
                    );
                    let _ = io::stdout().flush();
                }
                idx = (idx + 1) % ANIM_FRAMES.len();
                thread::sleep(Duration::from_millis(ANIM_INTERVAL_MS));
            }
        });
        Self {
            running,
            handle: Some(handle),
        }
    }

    fn stop(mut self) {
        self.running.store(false, Ordering::Relaxed);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

struct CliApp {
    stations: Vec<Station>,
    visible: Vec<usize>,
    query: String,
    source: SourceFilter,
    page: usize,
    player: Player,
    now_playing: Option<usize>,
    message: Option<(String, MessageKind)>,
    spinner: Option<Spinner>,
    output_lock: Arc<Mutex<()>>,
    reconnect_attempt: u32,
    reconnect_due: Option<Instant>,
    suppress_render_once: bool,
}

enum MessageKind {
    Info,
    Success,
    Warning,
    Error,
}

impl CliApp {
    fn new(stations: Vec<Station>) -> Self {
        let mut app = Self {
            stations,
            visible: Vec::new(),
            query: String::new(),
            source: SourceFilter::All,
            page: 0,
            player: Player::new(),
            now_playing: None,
            message: None,
            spinner: None,
            output_lock: Arc::new(Mutex::new(())),
            reconnect_attempt: 0,
            reconnect_due: None,
            suppress_render_once: false,
        };
        app.apply_filter();
        app
    }

    fn run(&mut self) {
        if !mpv_available() {
            self.set_message(
                "mpv belum ditemukan di PATH. Browse oke, playback belum bisa. Install: sudo apt install mpv",
                MessageKind::Warning,
            );
        }

        let input_rx = spawn_input_reader();
        self.render();

        loop {
            match input_rx.recv_timeout(PLAYBACK_POLL_INTERVAL) {
                Ok(input) => {
                    let input = input.trim();
                    if !self.handle_command(input) {
                        break;
                    }
                    if self.suppress_render_once {
                        self.suppress_render_once = false;
                    } else {
                        self.render();
                    }
                }
                Err(RecvTimeoutError::Timeout) => {
                    if !self.suppress_render_once && self.tick_playback() {
                        self.render();
                    }
                }
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }

        self.stop_animation();
        self.player.stop();
    }

    fn handle_command(&mut self, input: &str) -> bool {
        if input.is_empty() {
            self.message = None;
            return true;
        }

        let lower = input.to_lowercase();
        match lower.as_str() {
            "q" | "quit" | "exit" => return false,
            "h" | "help" | "?" => {
                self.show_help();
                self.suppress_render_once = true;
                return true;
            }
            "s" | "stop" => {
                self.clear_reconnect();
                self.stop_animation();
                self.player.stop();
                self.now_playing = None;
                self.set_message("Playback dihentikan.", MessageKind::Info);
                return true;
            }
            "p" | "pause" | "resume" => {
                match self.player.toggle_pause() {
                    Ok(()) => {
                        if self.player.paused {
                            self.stop_animation();
                            self.set_message("Paused.", MessageKind::Info);
                        } else {
                            self.start_animation();
                            self.set_message("Resumed.", MessageKind::Info);
                        }
                    }
                    Err(error) => self.set_message(&error, MessageKind::Warning),
                }
                return true;
            }
            "m" | "mute" | "unmute" => {
                match self.player.toggle_mute() {
                    Ok(()) => {
                        let msg = if self.player.muted {
                            "Muted."
                        } else {
                            "Unmuted."
                        };
                        self.set_message(msg, MessageKind::Info);
                    }
                    Err(error) => self.set_message(&error, MessageKind::Warning),
                }
                return true;
            }
            "+" | "vol+" | "volup" => {
                self.adjust_volume_message(5);
                return true;
            }
            "-" | "vol-" | "voldown" => {
                self.adjust_volume_message(-5);
                return true;
            }
            "n" | "next" => {
                self.clear_reconnect();
                self.cycle_station(1);
                return true;
            }
            "b" | "back" | "prev" | "previous" => {
                self.clear_reconnect();
                self.cycle_station(-1);
                return true;
            }
            "i" | "info" => {
                self.message = None;
                return true;
            }
            ">" | "next-page" | "np" => {
                self.next_page();
                return true;
            }
            "<" | "prev-page" | "pp" => {
                self.prev_page();
                return true;
            }
            "all" => {
                self.query.clear();
                self.source = SourceFilter::All;
                self.apply_filter();
                self.set_message("Menampilkan semua stasiun.", MessageKind::Info);
                return true;
            }
            "src1" | "id" | "indonesia" => {
                self.source = SourceFilter::Indonesia;
                self.apply_filter();
                self.set_message("Filter source: Indonesia.", MessageKind::Info);
                return true;
            }
            "src2" | "intl" | "international" => {
                self.source = SourceFilter::International;
                self.apply_filter();
                self.set_message("Filter source: International.", MessageKind::Info);
                return true;
            }
            "src" | "src0" => {
                self.source = SourceFilter::All;
                self.apply_filter();
                self.set_message("Filter source: Semua.", MessageKind::Info);
                return true;
            }
            _ => {}
        }

        if let Some(rest) = lower
            .strip_prefix("v ")
            .or_else(|| lower.strip_prefix("vol "))
            .or_else(|| lower.strip_prefix("volume "))
        {
            match rest.trim().parse::<u8>() {
                Ok(value) => match self.player.set_volume(value) {
                    Ok(()) => self.set_message(
                        &format!("Volume diset ke {}%.", self.player.volume),
                        MessageKind::Info,
                    ),
                    Err(error) => self.set_message(&error, MessageKind::Warning),
                },
                Err(_) => self.set_message(
                    "Format volume harus angka 0-100, contoh: v 70",
                    MessageKind::Warning,
                ),
            }
            return true;
        }

        if let Some(query) = input.strip_prefix('/') {
            self.search(query.trim());
            return true;
        }

        if let Ok(number) = input.parse::<usize>() {
            self.play_visible(number);
            return true;
        }

        self.search(input);
        true
    }

    fn render(&self) {
        let _guard = self.output_lock.lock().unwrap();
        print!("{CLEAR}");
        println!(
            "{BOLD}{CYAN}== Classic Radio CLI v{} ==={RESET}",
            env!("CARGO_PKG_VERSION")
        );
        println!();

        let now_playing_label = match self.now_playing {
            Some(index) => {
                let station = &self.stations[index];
                let (indicator, suffix) = if self.reconnect_due.is_some() {
                    (
                        format!("{YELLOW}↻{RESET}"),
                        format!(
                            "{DIM} (reconnecting attempt {}/{}){RESET}",
                            self.reconnect_attempt, RECONNECT_MAX_ATTEMPTS
                        ),
                    )
                } else if self.player.paused {
                    (
                        format!("{YELLOW}‖{RESET}"),
                        format!("{DIM} (paused){RESET}"),
                    )
                } else {
                    (format!("{GREEN}♪{RESET}"), String::new())
                };
                format!("{indicator} {GREEN}{}{RESET}{suffix}", station.name)
            }
            None => format!("{GREY}-{RESET}"),
        };
        let mute_label = if self.player.muted {
            format!("{RED}on{RESET}")
        } else {
            format!("{GREY}off{RESET}")
        };
        let search_label = if self.query.is_empty() {
            format!("{GREY}(none){RESET}")
        } else {
            format!("{YELLOW}{}{RESET}", self.query)
        };

        println!(" Now playing : {now_playing_label}");
        println!(
            " Volume      : {}%   Mute: {}",
            self.player.volume, mute_label
        );
        println!(" Source      : {}", self.source.label());
        println!(" Search      : {search_label}");
        println!(
            " Stations    : {} ditemukan{}",
            self.visible.len(),
            self.page_label()
        );
        println!();

        if self.visible.is_empty() {
            println!(" {DIM}Tidak ada stasiun cocok. Coba `all` atau /<kata>{RESET}");
        } else {
            println!(" {DIM}---- daftar stasiun ----{RESET}");
            for (position, index) in self.page_indices().iter().enumerate() {
                let station = &self.stations[*index];
                let marker = if Some(*index) == self.now_playing {
                    format!("{GREEN}>{RESET}")
                } else {
                    " ".to_string()
                };
                println!(" {marker}{:>2}. {}", position + 1, station_label(station));
            }
            println!(" {DIM}-------------------------{RESET}");
        }

        println!();
        let page_len = self.page_indices().len();
        let stasiun_hint = if page_len > 0 {
            format!("1–{page_len} play  ·  > < page  ·  /<kata> cari  ·  src1 src2 all source")
        } else {
            "> < page  ·  /<kata> cari  ·  src1 src2 all source".to_string()
        };
        println!(
            " {GREY}{:<8}{RESET}{DIM}│  {}{RESET}",
            "Stasiun", stasiun_hint
        );
        println!(
            " {GREY}{:<8}{RESET}{DIM}│  p pause  ·  m mute  ·  + − vol  ·  v <n> set  ·  n b next/prev  ·  s stop{RESET}",
            "Player"
        );
        println!(
            " {GREY}{:<8}{RESET}{DIM}│  i info  ·  h help  ·  q quit{RESET}",
            "Lain"
        );

        if let Some((message, kind)) = &self.message {
            let color = match kind {
                MessageKind::Info => CYAN,
                MessageKind::Success => GREEN,
                MessageKind::Warning => YELLOW,
                MessageKind::Error => RED,
            };
            println!();
            println!(" {color}{message}{RESET}");
        }
        println!();
        print!("classic-radio-cli> ");
        let _ = io::stdout().flush();
    }

    fn page_label(&self) -> String {
        if self.visible.is_empty() {
            return String::new();
        }
        let total_pages = self.total_pages();
        format!(", page {}/{}", self.page + 1, total_pages)
    }

    fn total_pages(&self) -> usize {
        if self.visible.is_empty() {
            1
        } else {
            (self.visible.len() + PAGE_SIZE - 1) / PAGE_SIZE
        }
    }

    fn page_indices(&self) -> &[usize] {
        if self.visible.is_empty() {
            return &[];
        }
        let start = self.page * PAGE_SIZE;
        let end = (start + PAGE_SIZE).min(self.visible.len());
        &self.visible[start..end]
    }

    fn next_page(&mut self) {
        if self.page + 1 < self.total_pages() {
            self.page += 1;
            self.message = None;
        } else {
            self.set_message("Sudah di halaman terakhir.", MessageKind::Info);
        }
    }

    fn prev_page(&mut self) {
        if self.page > 0 {
            self.page -= 1;
            self.message = None;
        } else {
            self.set_message("Sudah di halaman pertama.", MessageKind::Info);
        }
    }

    fn apply_filter(&mut self) {
        let lowered = self.query.to_lowercase();
        self.visible = self
            .stations
            .iter()
            .enumerate()
            .filter_map(|(index, station)| {
                if !self.source.matches(station) {
                    return None;
                }
                if lowered.is_empty() {
                    return Some(index);
                }
                let haystack = format!("{} {} {}", station.name, station.country, station.source)
                    .to_lowercase();
                if haystack.contains(&lowered) {
                    Some(index)
                } else {
                    None
                }
            })
            .collect();
        self.page = 0;
    }

    fn search(&mut self, query: &str) {
        self.query = query.to_string();
        self.apply_filter();
        if self.visible.is_empty() {
            self.set_message(
                "Tidak ada stasiun cocok dengan query itu.",
                MessageKind::Warning,
            );
        } else {
            self.message = None;
        }
    }

    fn play_visible(&mut self, number: usize) {
        let page = self.page_indices().to_vec();
        if number == 0 || number > page.len() {
            self.set_message(
                "Nomor tidak valid untuk halaman yang sedang tampil.",
                MessageKind::Warning,
            );
            return;
        }

        let station_index = page[number - 1];
        self.clear_reconnect();
        self.play_station(station_index);
    }

    fn play_station(&mut self, station_index: usize) {
        let station = self.stations[station_index].clone();
        self.stop_animation();
        match self.player.play(&station) {
            Ok(()) => {
                self.now_playing = Some(station_index);
                self.clear_reconnect();
                self.set_message(&format!("Playing: {}", station.name), MessageKind::Success);
                self.start_animation();
            }
            Err(error) => {
                self.now_playing = None;
                self.clear_reconnect();
                self.set_message(
                    &format!("Gagal menjalankan mpv: {error}. Install: sudo apt install mpv"),
                    MessageKind::Error,
                );
            }
        }
    }

    fn start_animation(&mut self) {
        self.stop_animation();
        let label = match self.now_playing {
            Some(idx) => self.stations[idx].name.clone(),
            None => return,
        };
        self.spinner = Some(Spinner::start(self.output_lock.clone(), label));
    }

    fn stop_animation(&mut self) {
        if let Some(spinner) = self.spinner.take() {
            spinner.stop();
        }
    }

    fn cycle_station(&mut self, delta: i32) {
        if self.visible.is_empty() {
            self.set_message("Daftar stasiun kosong.", MessageKind::Warning);
            return;
        }

        let current_pos = self
            .now_playing
            .and_then(|index| self.visible.iter().position(|i| *i == index));

        let total = self.visible.len() as i32;
        let next_pos = match current_pos {
            Some(pos) => ((pos as i32 + delta).rem_euclid(total)) as usize,
            None => {
                if delta >= 0 {
                    0
                } else {
                    self.visible.len() - 1
                }
            }
        };

        let station_index = self.visible[next_pos];
        self.page = next_pos / PAGE_SIZE;
        self.play_station(station_index);
    }

    fn tick_playback(&mut self) -> bool {
        if let Some(due) = self.reconnect_due {
            if Instant::now() >= due {
                self.reconnect_now();
                return true;
            }
            return false;
        }

        if self.now_playing.is_some() {
            if let Some(error) = self.player.poll_exit() {
                self.stop_animation();
                self.schedule_reconnect(&error);
                return true;
            }
        }

        false
    }

    fn schedule_reconnect(&mut self, reason: &str) {
        let Some(index) = self.now_playing else {
            return;
        };

        if self.reconnect_attempt >= RECONNECT_MAX_ATTEMPTS {
            let station_name = self.stations[index].name.clone();
            let reason = truncate(reason, 240);
            self.now_playing = None;
            self.clear_reconnect();
            self.set_message(
                &format!(
                    "Reconnect gagal untuk {station_name} setelah {RECONNECT_MAX_ATTEMPTS} percobaan. Terakhir: {reason}"
                ),
                MessageKind::Error,
            );
            return;
        }

        self.reconnect_attempt += 1;
        let delay = reconnect_delay(self.reconnect_attempt);
        self.reconnect_due = Some(Instant::now() + delay);
        let reason = truncate(reason, 240);
        self.set_message(
            &format!(
                "Stream terputus. Reconnecting attempt {}/{} dalam {}s. Terakhir: {}",
                self.reconnect_attempt,
                RECONNECT_MAX_ATTEMPTS,
                delay.as_secs(),
                reason
            ),
            MessageKind::Warning,
        );
    }

    fn reconnect_now(&mut self) {
        self.reconnect_due = None;
        let Some(index) = self.now_playing else {
            self.clear_reconnect();
            return;
        };

        let station = self.stations[index].clone();
        match self.player.play(&station) {
            Ok(()) => {
                self.set_message(
                    &format!("Reconnected: {}", station.name),
                    MessageKind::Success,
                );
                self.start_animation();
            }
            Err(error) => {
                self.stop_animation();
                self.schedule_reconnect(&format!("Gagal menjalankan mpv: {error}"));
            }
        }
    }

    fn clear_reconnect(&mut self) {
        self.reconnect_attempt = 0;
        self.reconnect_due = None;
    }

    fn adjust_volume_message(&mut self, delta: i32) {
        match self.player.adjust_volume(delta) {
            Ok(()) => self.set_message(
                &format!("Volume: {}%", self.player.volume),
                MessageKind::Info,
            ),
            Err(error) => self.set_message(&error, MessageKind::Warning),
        }
    }

    fn set_message(&mut self, text: &str, kind: MessageKind) {
        self.message = Some((text.to_string(), kind));
    }

    fn show_help(&mut self) {
        let _guard = self.output_lock.lock().unwrap();
        print!("{CLEAR}");
        println!("{BOLD}Classic Radio CLI - Help{RESET}");
        println!();
        println!("{BOLD}Daftar & Navigasi{RESET}");
        println!("  1..{:<3}        play stasiun di halaman ini", PAGE_SIZE);
        println!("  > | next-page  halaman berikutnya");
        println!("  < | prev-page  halaman sebelumnya");
        println!("  /<kata>        cari stasiun");
        println!("  all            tampilkan semua, reset filter");
        println!("  src1 | id      filter source Indonesia");
        println!("  src2 | intl    filter source International");
        println!("  src            reset source filter");
        println!();
        println!("{BOLD}Playback{RESET}");
        println!("  p | pause      toggle pause/resume");
        println!("  m | mute       toggle mute/unmute");
        println!("  + | -          volume +/- 5");
        println!("  v <0-100>      set volume");
        println!("  n | next       stasiun berikutnya (auto play)");
        println!("  b | prev       stasiun sebelumnya (auto play)");
        println!("  s | stop       hentikan playback");
        println!();
        println!("{BOLD}Lain{RESET}");
        println!("  i | info       refresh tampilan");
        println!("  h | help | ?   bantuan ini");
        println!("  q | quit       keluar");
        println!();
        println!("{DIM}Tekan Enter untuk kembali ke daftar stasiun...{RESET}");
        let _ = io::stdout().flush();
    }
}

fn load_stations() -> Vec<Station> {
    match serde_json::from_str::<Vec<Station>>(STATIONS_JSON) {
        Ok(stations) => stations,
        Err(error) => {
            eprintln!("Gagal membaca data stasiun bawaan: {error}");
            Vec::new()
        }
    }
}

fn station_label(station: &Station) -> String {
    let country = if station.country.is_empty() {
        station.source.as_str()
    } else {
        station.country.as_str()
    };
    if country.is_empty() {
        station.name.clone()
    } else {
        format!(
            "{:<32} {DIM}- {}{RESET}",
            truncate(&station.name, 32),
            country
        )
    }
}

fn truncate(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        value.to_string()
    } else {
        let mut out: String = value.chars().take(max.saturating_sub(1)).collect();
        out.push('…');
        out
    }
}

fn mpv_available() -> bool {
    Command::new("mpv")
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok()
}

fn make_socket_path() -> PathBuf {
    let dir = env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(env::temp_dir);
    dir.join(format!("classic-radio-cli-{}.sock", std::process::id()))
}

fn print_help_text() {
    println!("Classic Radio CLI v{}", env!("CARGO_PKG_VERSION"));
    println!();
    println!("Usage:");
    println!("  classic-radio          GUI desktop");
    println!("  classic-radio-cli      CLI terminal interaktif");
    println!();
    println!("Setelah CLI berjalan, ketik `h` untuk daftar command.");
    println!("Butuh mpv untuk playback: sudo apt install mpv");
}

struct TerminalGuard;

impl TerminalGuard {
    fn enter() -> Self {
        print!("{ENTER_ALT_SCREEN}");
        let _ = io::stdout().flush();
        Self
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        print!("{EXIT_ALT_SCREEN}");
        let _ = io::stdout().flush();
    }
}

fn main() {
    if env::args().any(|arg| arg == "-h" || arg == "--help") {
        print_help_text();
        return;
    }

    let _instance_lock = match InstanceLock::acquire("cli") {
        Ok(lock) => lock,
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    };

    let stations = load_stations();
    if stations.is_empty() {
        eprintln!("Tidak ada stasiun yang tersedia.");
        std::process::exit(1);
    }

    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        print!("{EXIT_ALT_SCREEN}");
        let _ = io::stdout().flush();
        default_hook(info);
    }));

    let _guard = TerminalGuard::enter();
    let mut app = CliApp::new(stations);
    app.run();
    println!("{DIM}Classic Radio CLI stopped.{RESET}");
}
