import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import Hls from "hls.js";
import { hydrateIcons, updateIcon } from "./icons.js";
import {
  loadFavorites,
  loadPreferences,
  loadStoredStations,
  persistFavorites,
  persistPreferences,
} from "./station-store.js";

const stationSelect = document.getElementById("stationSelect");
const stationSelectButton = document.getElementById("stationSelectButton");
const stationSelectLabel = document.getElementById("stationSelectLabel");
const stationMenu = document.getElementById("stationMenu");
const statusText = document.getElementById("status");
const audio = document.getElementById("radio");
const canvas = document.getElementById("visualizer");
const ctx = canvas.getContext("2d");

const playBtn = document.getElementById("playBtn");
const prevBtn = document.getElementById("prevBtn");
const nextBtn = document.getElementById("nextBtn");
const muteBtn = document.getElementById("muteBtn");
const volumeSlider = document.getElementById("volume");
const volumePercent = document.getElementById("volumePercent");
const favoritesFilterBtn = document.getElementById("favoritesFilterBtn");
const manageToggle = document.getElementById("manageToggle");
const favoriteBtn = document.getElementById("favoriteBtn");
const miniModeBtn = document.getElementById("miniModeBtn");
const minimizeBtn = document.getElementById("minimizeBtn");
const closeBtn = document.getElementById("closeBtn");
const titleDragRegion = document.getElementById("titleDragRegion");
const appWindow = getCurrentWindow();

let stations = loadStoredStations();
let preferences = loadPreferences();
let favorites = loadFavorites();
let currentSource = preferences.source;
let audioCtx;
let analyser;
let source;
let gainNode;
let dataArray;
let hls;
let visualizerStarted = false;
let lastAudibleVolume = Number(volumeSlider.value) || 1;
let selectedStationIndex = 0;
let currentStreamUrl = "";
let wantsPlayback = false;
let reconnectTimer;
let reconnectAttempt = 0;
let reconnectInFlight = false;
let favoritesOnly = false;
let watchdogTimer;
let lastProgressAt = 0;
let lastProgressTime = 0;

const DEBUG_LOG_KEY = "radio-debug-log";
const DEBUG_LOG_MAX = 1000;
const WATCHDOG_INTERVAL_MS = 5000;
const STUCK_THRESHOLD_MS = 15000;

let debugLogBuffer = [];
try {
  const saved = localStorage.getItem(DEBUG_LOG_KEY);
  if (saved) debugLogBuffer = JSON.parse(saved);
} catch {}

function debugLog(category, message, extras) {
  const ts = new Date().toISOString();
  const entry = { ts, category, message };
  if (extras) entry.extras = extras;
  debugLogBuffer.push(entry);
  if (debugLogBuffer.length > DEBUG_LOG_MAX) {
    debugLogBuffer = debugLogBuffer.slice(-DEBUG_LOG_MAX);
  }
  try { localStorage.setItem(DEBUG_LOG_KEY, JSON.stringify(debugLogBuffer)); } catch {}
  if (extras) console.log(`[${ts}] [${category}] ${message}`, extras);
  else console.log(`[${ts}] [${category}] ${message}`);
}

function audioStateSnapshot() {
  return {
    paused: audio.paused,
    currentTime: Number(audio.currentTime.toFixed(2)),
    readyState: audio.readyState,
    networkState: audio.networkState,
    errorCode: audio.error?.code ?? null,
    audioCtxState: audioCtx?.state ?? null,
    online: navigator.onLine,
    hidden: document.hidden,
    wantsPlayback,
    reconnectAttempt,
  };
}

function dumpDebugLog() {
  return debugLogBuffer.map((e) => {
    const head = `[${e.ts}] [${e.category}] ${e.message}`;
    return e.extras ? `${head} ${JSON.stringify(e.extras)}` : head;
  }).join("\n");
}

function currentStations() {
  const list = stations[currentSource] || [];
  if (!favoritesOnly) return list;
  return list.filter((station) => favorites.includes(station.url));
}

function savePreferences(overrides = {}) {
  preferences = {
    ...preferences,
    source: currentSource,
    stationUrl: selectedStation()?.url || preferences.stationUrl,
    volume: Number(volumeSlider.value),
    muted: audio.muted,
    ...overrides,
  };
  persistPreferences(preferences);
}

function setStatus(message, state = "idle") {
  statusText.textContent = message;
  statusText.dataset.state = state;
}

function emitPlayerState() {
  const station = selectedStation();
  emit("player-state", {
    playing: wantsPlayback && !audio.paused,
    stationName: station?.name || "",
  });
}

function loadStations() {
  const list = currentStations();
  const selectedUrl = list[selectedStationIndex]?.url;
  stationMenu.innerHTML = "";

  if (currentSource === "1") {
    list.forEach((station, index) => {
      stationMenu.appendChild(createStationMenuItem(station, index));
    });
  } else {
    const grouped = list.reduce((groups, station, index) => {
      const country = station.country || "International";
      if (!groups[country]) groups[country] = [];
      groups[country].push({ station, index });
      return groups;
    }, {});

    Object.keys(grouped).sort().forEach((country) => {
      const groupLabel = document.createElement("div");
      groupLabel.className = "station-menu-group";
      groupLabel.textContent = country;
      stationMenu.appendChild(groupLabel);
      grouped[country].forEach(({ station, index }) => {
        stationMenu.appendChild(createStationMenuItem(station, index));
      });
    });
  }

  const restoredIndex = list.findIndex((station) => station.url === selectedUrl);
  selectedStationIndex = restoredIndex >= 0 ? restoredIndex : 0;
  updateStationSelectLabel();
  updateFavoriteButton();
  savePreferences();
}

function createStationMenuItem(station, index) {
  const item = document.createElement("button");
  item.type = "button";
  item.className = "station-menu-item";
  item.dataset.index = String(index);
  item.textContent = station.name;
  item.addEventListener("click", () => {
    selectedStationIndex = index;
    updateStationSelectLabel();
    updateFavoriteButton();
    savePreferences();
    closeStationMenu();
    currentStreamUrl = "";
    playSelectedStation();
  });
  return item;
}

function selectedStation() {
  return currentStations()[selectedStationIndex];
}

function updateStationSelectLabel() {
  const station = selectedStation();
  stationSelectLabel.textContent = station?.name || "Tidak ada stasiun";
  stationMenu.querySelectorAll(".station-menu-item").forEach((item) => {
    item.classList.toggle("is-selected", Number(item.dataset.index) === selectedStationIndex);
  });
  updateFavoriteButton();
  emitPlayerState();
}

function selectedStationName() {
  return selectedStation()?.name || "Unknown station";
}

function playSelectedStation() {
  const url = selectedStation()?.url;
  if (!url) {
    setStatus("Tidak ada stasiun untuk diputar.", "error");
    return;
  }

  debugLog("play", "playSelectedStation", { url, station: selectedStationName(), state: audioStateSnapshot() });
  wantsPlayback = true;
  reconnectAttempt = 0;
  clearReconnect();
  initVisualizer();
  if (audioCtx?.state === "suspended") {
    audioCtx.resume().catch((err) => debugLog("audioctx", "resume failed", { error: String(err) }));
  }
  if (!prepareStream(url)) return;
  setStatus("Loading: " + selectedStationName(), "loading");
  updatePlayPauseButton();

  audio.play()
    .then(() => {
      reconnectAttempt = 0;
      setStatus("Now Playing: " + selectedStationName(), "playing");
      if (audioCtx?.state === "suspended") audioCtx.resume();
      updatePlayPauseButton();
      emitPlayerState();
      savePreferences();
      debugLog("play", "play() resolved");
    })
    .catch((error) => {
      console.error("Play error:", error);
      debugLog("play", "play() rejected", { error: String(error), state: audioStateSnapshot() });
      setStatus("Playback blocked or stream failed: " + selectedStationName(), "error");
      scheduleReconnect("play-error");
    });
}

function prepareStream(url, forceReload = false) {
  if (!forceReload && currentStreamUrl === url) return true;

  debugLog("stream", "prepareStream", { url, forceReload, prevError: audio.error?.code ?? null });
  currentStreamUrl = url;

  if (hls) {
    hls.destroy();
    hls = null;
  }

  // Hard reset audio element to clear any sticky error/network state from previous stream
  try { audio.pause(); } catch (e) { debugLog("stream", "pause threw", { error: String(e) }); }
  audio.removeAttribute("src");
  try { audio.load(); } catch (e) { debugLog("stream", "load threw", { error: String(e) }); }

  const isHlsStream = url.toLowerCase().includes(".m3u8");
  if (Hls.isSupported() && isHlsStream) {
    hls = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
      backBufferLength: 30,
    });
    hls.on(Hls.Events.ERROR, (_event, data) => {
      console.warn("HLS error:", data);
      debugLog("hls", "error", { type: data.type, details: data.details, fatal: data.fatal });
      if (data.fatal) scheduleReconnect("hls-error");
    });
    hls.loadSource(url);
    hls.attachMedia(audio);
  } else if (isHlsStream && !audio.canPlayType("application/vnd.apple.mpegurl")) {
    setStatus("HLS stream tidak didukung oleh runtime ini.", "error");
    wantsPlayback = false;
    updatePlayPauseButton();
    emitPlayerState();
    return false;
  } else {
    audio.src = url;
    audio.load();
  }

  return true;
}

function changeStation(direction) {
  const totalStations = currentStations().length;
  if (!totalStations) return;

  let currentIndex = selectedStationIndex;
  currentIndex = direction === "next" ? currentIndex + 1 : currentIndex - 1;
  if (currentIndex >= totalStations) currentIndex = 0;
  if (currentIndex < 0) currentIndex = totalStations - 1;

  selectedStationIndex = currentIndex;
  updateStationSelectLabel();
  savePreferences();
  currentStreamUrl = "";
  playSelectedStation();
}

function togglePlayPause() {
  if (!wantsPlayback || audio.paused) {
    playSelectedStation();
  } else {
    wantsPlayback = false;
    clearReconnect();
    audio.pause();
    setStatus("Paused: " + selectedStationName(), "paused");
    updatePlayPauseButton();
    emitPlayerState();
  }
}

function updateTooltip(button, direction) {
  const totalStations = currentStations().length;
  if (!totalStations) return;

  const currentIndex = selectedStationIndex;
  const targetIndex = direction === "next"
    ? (currentIndex + 1) % totalStations
    : (currentIndex - 1 + totalStations) % totalStations;

  button.title = currentStations()[targetIndex]?.name || "";
}

document.querySelectorAll("input[name='source']").forEach((radio) => {
  radio.addEventListener("change", (event) => {
    currentSource = event.target.value;
    selectedStationIndex = 0;
    loadStations();
    setStatus("Source changed. Select a station to play.", "idle");
    wantsPlayback = false;
    clearReconnect();
    currentStreamUrl = "";
    audio.pause();
    updatePlayPauseButton();
    emitPlayerState();
    savePreferences({ stationUrl: selectedStation()?.url || "" });
  });
});

playBtn.addEventListener("click", togglePlayPause);
nextBtn.addEventListener("click", () => changeStation("next"));
prevBtn.addEventListener("click", () => changeStation("prev"));
nextBtn.addEventListener("mouseover", () => updateTooltip(nextBtn, "next"));
prevBtn.addEventListener("mouseover", () => updateTooltip(prevBtn, "prev"));

volumeSlider.addEventListener("input", (event) => {
  const volume = Number(event.target.value);
  setOutputVolume(volume);
  updateVolumePercent(volume);

  if (volume > 0) {
    lastAudibleVolume = volume;
    audio.muted = false;
    updateMuteIcon(false);
  } else {
    audio.muted = true;
    setOutputVolume(0);
    updateMuteIcon(true);
  }
  savePreferences({ volume, muted: audio.muted });
});

muteBtn.addEventListener("click", () => {
  if (audio.muted || audio.volume === 0) {
    audio.muted = false;
    setOutputVolume(lastAudibleVolume);
    volumeSlider.value = String(lastAudibleVolume);
    updateVolumePercent(lastAudibleVolume);
    updateMuteIcon(false);
    setStatus("Unmuted", "idle");
  } else {
    lastAudibleVolume = audio.volume || lastAudibleVolume;
    audio.muted = true;
    setOutputVolume(0);
    volumeSlider.value = "0";
    updateVolumePercent(0);
    updateMuteIcon(true);
    setStatus("Muted", "idle");
  }
  savePreferences({ volume: Number(volumeSlider.value), muted: audio.muted });
});

function setOutputVolume(volume) {
  audio.volume = volume;
  if (gainNode) gainNode.gain.value = volume;
}

function updateMuteIcon(isMuted) {
  const icon = muteBtn.querySelector(".ui-icon");
  updateIcon(icon, isMuted ? "icon-muted" : "icon-volume");
  muteBtn.title = isMuted ? "Unmute" : "Mute";
}

function updateVolumePercent(volume = Number(volumeSlider.value)) {
  volumePercent.textContent = Math.round(volume * 100) + "%";
  volumeSlider.style.setProperty("--volume-fill", `${Math.round(volume * 100)}%`);
}

function updatePlayPauseButton() {
  const isStreaming = wantsPlayback && !audio.paused;
  const icon = playBtn.querySelector(".ui-icon");
  updateIcon(icon, isStreaming ? "icon-pause" : "icon-play");
  playBtn.title = isStreaming ? "Pause" : "Play";
  emitPlayerState();
}

manageToggle.addEventListener("click", () => {
  openStationManager();
});

favoriteBtn.addEventListener("click", () => {
  const url = selectedStation()?.url;
  if (!url) return;

  if (favorites.includes(url)) {
    favorites = favorites.filter((favoriteUrl) => favoriteUrl !== url);
  } else {
    favorites.push(url);
  }

  persistFavorites(favorites);
  updateFavoriteButton();
  if (favoritesOnly) loadStations();
});

favoritesFilterBtn.addEventListener("click", () => {
  favoritesOnly = !favoritesOnly;
  favoritesFilterBtn.classList.toggle("is-active", favoritesOnly);
  favoritesFilterBtn.setAttribute("aria-pressed", String(favoritesOnly));
  selectedStationIndex = 0;
  loadStations();
  setStatus(favoritesOnly ? "Showing favorite stations." : "Showing all stations.", "idle");
});

miniModeBtn.addEventListener("click", () => {
  const enabled = !document.body.classList.contains("mini-mode");
  setMiniMode(enabled);
  savePreferences({ miniMode: enabled });
});

titleDragRegion.addEventListener("mousedown", (event) => {
  if (event.button !== 0 || event.target.closest("button")) return;
  appWindow.startDragging();
});

stationSelectButton.addEventListener("click", () => {
  stationMenu.hidden = !stationMenu.hidden;
  stationSelect.classList.toggle("is-open", !stationMenu.hidden);
});

document.addEventListener("click", (event) => {
  if (!stationSelect.contains(event.target)) closeStationMenu();
});

function closeStationMenu() {
  stationMenu.hidden = true;
  stationSelect.classList.remove("is-open");
}

function updateFavoriteButton() {
  const isFavorite = favorites.includes(selectedStation()?.url);
  favoriteBtn.classList.toggle("is-active", isFavorite);
  favoriteBtn.setAttribute("aria-pressed", String(isFavorite));
  favoriteBtn.title = isFavorite ? "Remove favorite" : "Favorite station";
}

function setMiniMode(enabled) {
  document.body.classList.toggle("mini-mode", enabled);
  miniModeBtn.classList.toggle("is-active", enabled);
  miniModeBtn.setAttribute("aria-pressed", String(enabled));
  miniModeBtn.title = enabled ? "Full mode" : "Mini mode";
  resizeForMode(enabled);
}

async function resizeForMode(enabled) {
  const size = enabled ? new LogicalSize(292, 132) : new LogicalSize(430, 560);

  try {
    await appWindow.setMinSize(enabled ? new LogicalSize(292, 132) : new LogicalSize(390, 520));
    await appWindow.setSize(size);
  } catch (error) {
    console.warn("Failed to resize window for mode:", error);
  }
}

minimizeBtn.addEventListener("click", () => {
  appWindow.minimize();
});

closeBtn.addEventListener("click", () => {
  appWindow.hide();
});

async function openStationManager() {
  const existing = await WebviewWindow.getByLabel("station-manager");
  if (existing) {
    await existing.show();
    await existing.setFocus();
    return;
  }

  const managerWindow = new WebviewWindow("station-manager", {
    url: "/manager.html",
    title: "Kelola Stasiun",
    width: 520,
    height: 640,
    minWidth: 440,
    minHeight: 520,
    center: true,
    resizable: true,
    decorations: false,
  });

  managerWindow.once("tauri://error", (event) => {
    console.error("Failed to open station manager:", event.payload);
  });
}

function initVisualizer() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioCtx.createAnalyser();
    gainNode = audioCtx.createGain();
    source = audioCtx.createMediaElementSource(audio);
    source.connect(analyser);
    analyser.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    gainNode.gain.value = audio.muted ? 0 : Number(volumeSlider.value);
    analyser.fftSize = 256;
    dataArray = new Uint8Array(analyser.frequencyBinCount);
  }

  if (!visualizerStarted) {
    visualizerStarted = true;
    drawVisualizer();
  }
}

function drawVisualizer() {
  requestAnimationFrame(drawVisualizer);
  if (!analyser) return;

  analyser.getByteFrequencyData(dataArray);
  ctx.fillStyle = "#3e2723";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const barWidth = (canvas.width / dataArray.length) * 2.5;
  let x = 0;

  for (let i = 0; i < dataArray.length; i++) {
    const barHeight = dataArray[i];
    const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
    gradient.addColorStop(0, "#ffd700");
    gradient.addColorStop(1, "#8d6e63");

    ctx.fillStyle = gradient;
    ctx.fillRect(x, canvas.height - barHeight / 2, barWidth, barHeight / 2);
    x += barWidth + 1;
  }
}

window.addEventListener("resize", () => {
  canvas.width = canvas.offsetWidth;
  canvas.height = canvas.offsetHeight;
});

listen("tray-control", (event) => {
  if (event.payload === "play-pause") togglePlayPause();
  if (event.payload === "next") changeStation("next");
  if (event.payload === "previous") changeStation("prev");
});

listen("stations-updated", () => {
  stations = loadStoredStations();
  loadStations();
});

audio.addEventListener("playing", () => {
  reconnectAttempt = 0;
  lastProgressAt = Date.now();
  lastProgressTime = audio.currentTime;
  setStatus("Now Playing: " + selectedStationName(), "playing");
  updatePlayPauseButton();
  emitPlayerState();
  debugLog("audio", "playing");
});

audio.addEventListener("pause", () => {
  updatePlayPauseButton();
  emitPlayerState();
  debugLog("audio", "pause", { wantsPlayback });
});
audio.addEventListener("ended", () => {
  debugLog("audio", "ended", { wantsPlayback });
  if (wantsPlayback) scheduleReconnect("ended");
});
audio.addEventListener("error", () => {
  debugLog("audio", "error", { errorCode: audio.error?.code ?? null, state: audioStateSnapshot() });
  if (wantsPlayback) {
    setStatus("Stream error: " + selectedStationName(), "error");
    scheduleReconnect("audio-error");
  }
});
audio.addEventListener("stalled", () => {
  debugLog("audio", "stalled", { wantsPlayback, state: audioStateSnapshot() });
  if (wantsPlayback) {
    setStatus("Stream stalled: " + selectedStationName(), "loading");
    scheduleReconnect("stalled");
  }
});
audio.addEventListener("waiting", () => {
  debugLog("audio", "waiting", { wantsPlayback, online: navigator.onLine });
  if (wantsPlayback) setStatus("Buffering: " + selectedStationName(), "loading");
  if (wantsPlayback && !navigator.onLine) scheduleReconnect("offline-waiting");
});

window.addEventListener("offline", () => {
  debugLog("network", "offline", { wantsPlayback });
  if (!wantsPlayback) return;
  setStatus("Offline. Reconnecting when internet returns...", "offline");
  scheduleReconnect("offline");
});

window.addEventListener("online", () => {
  debugLog("network", "online", { wantsPlayback });
  if (!wantsPlayback) return;
  reconnectAttempt = 0;
  reconnectNow("online");
});

document.addEventListener("visibilitychange", () => {
  debugLog("visibility", document.hidden ? "hidden" : "visible", { state: audioStateSnapshot() });
  if (document.hidden) return;
  if (audioCtx?.state === "suspended") {
    audioCtx.resume().catch((err) => debugLog("audioctx", "resume failed on visible", { error: String(err) }));
  }
  if (wantsPlayback && audio.paused) {
    debugLog("visibility", "wantsPlayback+paused → reconnect");
    reconnectAttempt = 0;
    reconnectNow("visibility-change");
  }
});

window.addEventListener("focus", () => {
  if (audioCtx?.state === "suspended") {
    audioCtx.resume().catch((err) => debugLog("audioctx", "resume failed on focus", { error: String(err) }));
  }
});

watchdogTimer = setInterval(() => {
  if (!wantsPlayback || audio.paused) {
    lastProgressAt = Date.now();
    lastProgressTime = audio.currentTime;
    return;
  }
  const now = Date.now();
  if (Math.abs(audio.currentTime - lastProgressTime) > 0.05) {
    lastProgressAt = now;
    lastProgressTime = audio.currentTime;
    return;
  }
  if (now - lastProgressAt >= STUCK_THRESHOLD_MS) {
    debugLog("watchdog", "stuck — currentTime not progressing", {
      stuckForMs: now - lastProgressAt,
      state: audioStateSnapshot(),
    });
    lastProgressAt = now;
    lastProgressTime = audio.currentTime;
    scheduleReconnect("watchdog-stuck");
  }
}, WATCHDOG_INTERVAL_MS);

function scheduleReconnect(reason) {
  if (!wantsPlayback) return;
  if (reconnectInFlight) {
    debugLog("reconnect", "skip schedule — already in flight", { reason });
    return;
  }
  if (reconnectTimer) {
    debugLog("reconnect", "skip schedule — already scheduled", { reason });
    return;
  }

  let delay;
  if (!navigator.onLine) delay = 3000;
  else if (reconnectAttempt < 5) delay = 1000 * 2 ** reconnectAttempt;
  else if (reconnectAttempt < 15) delay = 15000;
  else delay = 30000;
  reconnectAttempt += 1;
  debugLog("reconnect", "scheduled", { reason, delay, attempt: reconnectAttempt, state: audioStateSnapshot() });
  setStatus(navigator.onLine
    ? `Reconnecting... (${reason})`
    : "Offline. Waiting for connection...", navigator.onLine ? "loading" : "offline");

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectNow(reason);
  }, delay);
}

function reconnectNow(reason) {
  if (!wantsPlayback) return;
  if (reconnectInFlight) {
    debugLog("reconnect", "reconnectNow skipped — already in flight", { reason });
    return;
  }
  clearTimeout(reconnectTimer);
  reconnectTimer = null;

  const url = selectedStation()?.url;
  if (!url) return;

  reconnectInFlight = true;
  console.info("Reconnecting stream:", reason);
  debugLog("reconnect", "reconnectNow", { reason, url, state: audioStateSnapshot() });
  if (audioCtx?.state === "suspended") {
    audioCtx.resume().catch((err) => debugLog("audioctx", "resume failed in reconnect", { error: String(err) }));
  }
  if (!prepareStream(url, true)) {
    reconnectInFlight = false;
    return;
  }
  audio.play()
    .then(() => {
      reconnectInFlight = false;
      reconnectAttempt = 0;
      setStatus("Now Playing: " + selectedStationName(), "playing");
      updatePlayPauseButton();
      emitPlayerState();
      debugLog("reconnect", "reconnect play() resolved");
    })
    .catch((error) => {
      reconnectInFlight = false;
      console.warn("Reconnect failed:", error);
      debugLog("reconnect", "reconnect play() rejected", { error: String(error), state: audioStateSnapshot() });
      scheduleReconnect("retry-failed");
    });
}

function clearReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  reconnectInFlight = false;
}

function applyInitialPreferences() {
  document.querySelectorAll("input[name='source']").forEach((radio) => {
    radio.checked = radio.value === currentSource;
  });

  const savedIndex = (stations[currentSource] || [])
    .findIndex((station) => station.url === preferences.stationUrl);
  selectedStationIndex = savedIndex >= 0 ? savedIndex : 0;

  volumeSlider.value = String(preferences.volume);
  setOutputVolume(preferences.volume);
  audio.muted = preferences.muted;
  if (!preferences.muted && preferences.volume > 0) {
    lastAudibleVolume = preferences.volume;
  }
  updateMuteIcon(audio.muted || preferences.volume === 0);
  setMiniMode(preferences.miniMode);
}

document.addEventListener("keydown", (event) => {
  if (event.ctrlKey && event.shiftKey && (event.key === "L" || event.key === "l")) {
    event.preventDefault();
    const text = dumpDebugLog();
    navigator.clipboard.writeText(text)
      .then(() => setStatus(`Log copied (${debugLogBuffer.length} entries)`, "idle"))
      .catch((err) => {
        console.error("clipboard write failed:", err);
        console.log("=== DEBUG LOG DUMP ===\n" + text);
        setStatus("Log dumped to console", "idle");
      });
    return;
  }
  if (event.ctrlKey && event.shiftKey && (event.key === "K" || event.key === "k")) {
    event.preventDefault();
    debugLogBuffer = [];
    try { localStorage.removeItem(DEBUG_LOG_KEY); } catch {}
    setStatus("Debug log cleared", "idle");
    return;
  }

  if (event.target.closest("input, textarea, select")) return;

  if (event.key === " ") {
    event.preventDefault();
    togglePlayPause();
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    changeStation("next");
  } else if (event.key === "ArrowLeft") {
    event.preventDefault();
    changeStation("prev");
  } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
    event.preventDefault();
    const delta = event.key === "ArrowUp" ? 0.05 : -0.05;
    const volume = Math.min(1, Math.max(0, Number(volumeSlider.value) + delta));
    volumeSlider.value = String(volume);
    volumeSlider.dispatchEvent(new Event("input"));
  } else if (event.key === "Escape") {
    closeStationMenu();
  }
});

hydrateIcons();
const appVersionEl = document.getElementById("appVersion");
if (appVersionEl) {
  appVersionEl.textContent = `v${__APP_VERSION__}`;
}
applyInitialPreferences();
loadStations();
updateVolumePercent();
updatePlayPauseButton();
window.dispatchEvent(new Event("resize"));
debugLog("session", "app started", { version: __APP_VERSION__, userAgent: navigator.userAgent });
