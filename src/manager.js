import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { hydrateIcons } from "./icons.js";
import {
  defaultStations,
  loadStoredStations,
  normalizeStationGroups,
  persistStations,
  validateStation,
} from "./station-store.js";

const appWindow = getCurrentWindow();
const titleDragRegion = document.getElementById("managerTitleDragRegion");
const closeManagerBtn = document.getElementById("closeManagerBtn");
const stationForm = document.getElementById("stationForm");
const stationIndexInput = document.getElementById("stationIndex");
const stationNameInput = document.getElementById("stationName");
const stationUrlInput = document.getElementById("stationUrl");
const stationCountryInput = document.getElementById("stationCountry");
const stationList = document.getElementById("stationList");
const cancelEditBtn = document.getElementById("cancelEditBtn");
const resetStationsBtn = document.getElementById("resetStationsBtn");
const importStationsBtn = document.getElementById("importStationsBtn");
const exportStationsBtn = document.getElementById("exportStationsBtn");
const importStationsInput = document.getElementById("importStationsInput");
const testStreamBtn = document.getElementById("testStreamBtn");
const formError = document.getElementById("formError");
const editModeLabel = document.getElementById("editModeLabel");

let stations = loadStoredStations();
let currentSource = "1";
let testAudio;

function currentStations() {
  return stations[currentSource] || [];
}

function saveAndNotify() {
  sortStations();
  persistStations(stations);
  emit("stations-updated");
}

function sortStations() {
  for (const source of ["1", "2"]) {
    stations[source].sort((a, b) => a.name.localeCompare(b.name));
  }
}

function showFormError(message) {
  formError.textContent = message;
  formError.hidden = !message;
}

function renderStationList() {
  const list = currentStations();
  stationList.innerHTML = "";

  if (!list.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "Belum ada stasiun.";
    stationList.appendChild(empty);
    return;
  }

  list.forEach((station, index) => {
    const row = document.createElement("div");
    row.className = "station-row";

    const info = document.createElement("div");
    info.className = "station-info";

    const name = document.createElement("strong");
    name.textContent = station.name;

    const meta = document.createElement("span");
    meta.textContent = station.country || (currentSource === "1" ? "Indonesia" : "International");

    info.append(name, meta);

    const actions = document.createElement("div");
    actions.className = "row-actions";

    const editButton = document.createElement("button");
    editButton.type = "button";
    editButton.title = "Edit";
    editButton.innerHTML = '<span class="ui-icon icon-edit" aria-hidden="true"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3Z" /><path d="m14 7 3 3" /></svg></span>';
    editButton.addEventListener("click", () => startEditStation(index));

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.title = "Hapus";
    deleteButton.innerHTML = '<span class="ui-icon icon-delete" aria-hidden="true"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M5 7h14M10 11v6M14 11v6M8 7l1-3h6l1 3M7 7l1 13h8l1-13" /></svg></span>';
    deleteButton.addEventListener("click", () => deleteStation(index));

    actions.append(editButton, deleteButton);
    row.append(info, actions);
    stationList.appendChild(row);
  });
}

function startEditStation(index) {
  const station = currentStations()[index];
  if (!station) return;

  stationIndexInput.value = String(index);
  stationNameInput.value = station.name;
  stationUrlInput.value = station.url;
  stationCountryInput.value = station.country || "";
  editModeLabel.textContent = "Edit stasiun";
  showFormError("");
  stationNameInput.focus();
}

function clearForm() {
  stationForm.reset();
  stationIndexInput.value = "";
  editModeLabel.textContent = "Tambah stasiun baru";
  showFormError("");
}

function deleteStation(index) {
  const list = currentStations();
  if (!list[index]) return;
  if (!confirm(`Hapus stasiun "${list[index].name}"?`)) return;

  list.splice(index, 1);
  saveAndNotify();
  clearForm();
  renderStationList();
}

document.querySelectorAll("input[name='source']").forEach((radio) => {
  radio.addEventListener("change", (event) => {
    currentSource = event.target.value;
    clearForm();
    renderStationList();
  });
});

stationForm.addEventListener("submit", (event) => {
  event.preventDefault();

  const list = currentStations();
  const index = stationIndexInput.value === "" ? -1 : Number(stationIndexInput.value);
  const station = {
    name: stationNameInput.value.trim(),
    url: stationUrlInput.value.trim(),
    country: stationCountryInput.value.trim() || (currentSource === "1" ? "Indonesia" : "International"),
  };
  const validation = validateStation(station);

  if (!validation.valid) {
    showFormError(validation.message);
    return;
  }

  showFormError("");

  if (index >= 0) {
    list[index] = validation.station;
  } else {
    list.push(validation.station);
  }

  saveAndNotify();
  clearForm();
  renderStationList();
});

cancelEditBtn.addEventListener("click", clearForm);
resetStationsBtn.addEventListener("click", () => {
  if (!confirm("Reset semua stasiun ke data bawaan?")) return;
  stations = defaultStations();
  saveAndNotify();
  clearForm();
  renderStationList();
});

testStreamBtn.addEventListener("click", () => {
  const validation = validateStation({
    name: stationNameInput.value.trim() || "Test stream",
    url: stationUrlInput.value.trim(),
    country: stationCountryInput.value.trim(),
  });

  if (!validation.valid) {
    showFormError(validation.message);
    return;
  }

  if (testAudio) {
    testAudio.pause();
    testAudio.src = "";
  }

  showFormError("Testing stream...");
  testAudio = new Audio(validation.station.url);
  testAudio.crossOrigin = "anonymous";
  testAudio.volume = 0;
  testAudio.addEventListener("canplay", () => {
    showFormError("Stream bisa dibuka.");
    testAudio.pause();
  }, { once: true });
  testAudio.addEventListener("error", () => {
    showFormError("Stream tidak bisa dibuka dari runtime ini.");
  }, { once: true });
  testAudio.play().catch(() => {
    showFormError("Stream tidak bisa diputar otomatis, tetapi URL valid.");
  });
});

exportStationsBtn.addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(stations, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "classic-radio-stations.json";
  link.click();
  URL.revokeObjectURL(link.href);
});

importStationsBtn.addEventListener("click", () => {
  importStationsInput.click();
});

importStationsInput.addEventListener("change", () => {
  const [file] = importStationsInput.files;
  if (!file) return;

  const reader = new FileReader();
  reader.addEventListener("load", () => {
    try {
      const imported = normalizeStationGroups(JSON.parse(reader.result));
      if (!imported) {
        showFormError("File import harus berisi source 1 dan 2 dengan station valid.");
        return;
      }

      if (!confirm("Import akan mengganti semua daftar stasiun. Lanjutkan?")) return;
      stations = imported;
      saveAndNotify();
      clearForm();
      renderStationList();
    } catch {
      showFormError("File import bukan JSON valid.");
    } finally {
      importStationsInput.value = "";
    }
  });
  reader.readAsText(file);
});

closeManagerBtn.addEventListener("click", () => {
  appWindow.close();
});

titleDragRegion.addEventListener("mousedown", (event) => {
  if (event.button !== 0 || event.target.closest("button")) return;
  appWindow.startDragging();
});

hydrateIcons();
sortStations();
renderStationList();
