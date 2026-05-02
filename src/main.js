import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { loadStoredStations } from "./station-store.js";

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
const manageToggle = document.getElementById("manageToggle");
const minimizeBtn = document.getElementById("minimizeBtn");
const closeBtn = document.getElementById("closeBtn");
const titleDragRegion = document.getElementById("titleDragRegion");
const appWindow = getCurrentWindow();

let stations = loadStoredStations();
let currentSource = "1";
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

function currentStations() {
  return stations[currentSource] || [];
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
    closeStationMenu();
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
}

function selectedStationName() {
  return selectedStation()?.name || "Unknown station";
}

function playSelectedStation() {
  const url = selectedStation()?.url;
  if (!url) {
    statusText.textContent = "Tidak ada stasiun untuk diputar.";
    return;
  }

  wantsPlayback = true;
  clearReconnect();
  initVisualizer();
  prepareStream(url);

  audio.play()
    .then(() => {
      reconnectAttempt = 0;
      statusText.textContent = "Now Playing: " + selectedStationName();
      if (audioCtx?.state === "suspended") audioCtx.resume();
      updatePlayPauseButton();
    })
    .catch((error) => {
      console.error("Play error:", error);
      statusText.textContent = "Error playing station.";
      scheduleReconnect("play-error");
    });
}

function prepareStream(url, forceReload = false) {
  if (!forceReload && currentStreamUrl === url) return;

  currentStreamUrl = url;

  if (hls) {
    hls.destroy();
    hls = null;
  }

  if (window.Hls?.isSupported() && url.endsWith(".m3u8")) {
    hls = new window.Hls({
      enableWorker: true,
      lowLatencyMode: false,
      backBufferLength: 30,
    });
    hls.on(window.Hls.Events.ERROR, (_event, data) => {
      console.warn("HLS error:", data);
      if (data.fatal) scheduleReconnect("hls-error");
    });
    hls.loadSource(url);
    hls.attachMedia(audio);
  } else {
    audio.src = url;
    audio.load();
  }
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
    statusText.textContent = "Paused";
    updatePlayPauseButton();
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
    statusText.textContent = "Source changed. Select a station to play.";
    wantsPlayback = false;
    clearReconnect();
    currentStreamUrl = "";
    audio.pause();
    updatePlayPauseButton();
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
});

muteBtn.addEventListener("click", () => {
  if (audio.muted || audio.volume === 0) {
    audio.muted = false;
    setOutputVolume(lastAudibleVolume);
    volumeSlider.value = String(lastAudibleVolume);
    updateVolumePercent(lastAudibleVolume);
    updateMuteIcon(false);
    statusText.textContent = "Unmuted";
  } else {
    lastAudibleVolume = audio.volume || lastAudibleVolume;
    audio.muted = true;
    setOutputVolume(0);
    volumeSlider.value = "0";
    updateVolumePercent(0);
    updateMuteIcon(true);
    statusText.textContent = "Muted";
  }
});

function setOutputVolume(volume) {
  audio.volume = volume;
  if (gainNode) gainNode.gain.value = volume;
}

function updateMuteIcon(isMuted) {
  const icon = muteBtn.querySelector("i");
  icon.classList.toggle("fa-volume-up", !isMuted);
  icon.classList.toggle("fa-volume-mute", isMuted);
}

function updateVolumePercent(volume = Number(volumeSlider.value)) {
  volumePercent.textContent = Math.round(volume * 100) + "%";
  volumeSlider.style.setProperty("--volume-fill", `${Math.round(volume * 100)}%`);
}

function updatePlayPauseButton() {
  const isStreaming = wantsPlayback && !audio.paused;
  const icon = playBtn.querySelector("i");
  icon.classList.toggle("fa-play", !isStreaming);
  icon.classList.toggle("fa-pause", isStreaming);
  playBtn.title = isStreaming ? "Pause" : "Play";
}

manageToggle.addEventListener("click", () => {
  openStationManager();
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
  updatePlayPauseButton();
});

audio.addEventListener("pause", updatePlayPauseButton);
audio.addEventListener("ended", () => {
  if (wantsPlayback) scheduleReconnect("ended");
});
audio.addEventListener("error", () => {
  if (wantsPlayback) scheduleReconnect("audio-error");
});
audio.addEventListener("stalled", () => {
  if (wantsPlayback) scheduleReconnect("stalled");
});
audio.addEventListener("waiting", () => {
  if (wantsPlayback && !navigator.onLine) scheduleReconnect("offline-waiting");
});

window.addEventListener("offline", () => {
  if (!wantsPlayback) return;
  statusText.textContent = "Offline. Reconnecting when internet returns...";
  scheduleReconnect("offline");
});

window.addEventListener("online", () => {
  if (!wantsPlayback) return;
  reconnectAttempt = 0;
  reconnectNow("online");
});

function scheduleReconnect(reason) {
  if (!wantsPlayback) return;
  clearTimeout(reconnectTimer);

  const delay = navigator.onLine
    ? Math.min(15000, 1000 * 2 ** Math.min(reconnectAttempt, 4))
    : 3000;
  reconnectAttempt += 1;
  statusText.textContent = navigator.onLine
    ? `Reconnecting... (${reason})`
    : "Offline. Waiting for connection...";

  reconnectTimer = setTimeout(() => reconnectNow(reason), delay);
}

function reconnectNow(reason) {
  if (!wantsPlayback) return;
  const url = selectedStation()?.url;
  if (!url) return;

  console.info("Reconnecting stream:", reason);
  prepareStream(url, true);
  audio.play()
    .then(() => {
      reconnectAttempt = 0;
      statusText.textContent = "Now Playing: " + selectedStationName();
      updatePlayPauseButton();
    })
    .catch((error) => {
      console.warn("Reconnect failed:", error);
      scheduleReconnect("retry-failed");
    });
}

function clearReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

loadStations();
updateVolumePercent();
updatePlayPauseButton();
window.dispatchEvent(new Event("resize"));
