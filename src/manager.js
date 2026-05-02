import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { defaultStations, loadStoredStations, persistStations } from "./station-store.js";

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

let stations = loadStoredStations();
let currentSource = "1";

function currentStations() {
  return stations[currentSource] || [];
}

function saveAndNotify() {
  persistStations(stations);
  emit("stations-updated");
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
    editButton.innerHTML = '<i class="fa-solid fa-pen"></i>';
    editButton.addEventListener("click", () => startEditStation(index));

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.title = "Hapus";
    deleteButton.innerHTML = '<i class="fa-solid fa-trash"></i>';
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
  stationNameInput.focus();
}

function clearForm() {
  stationForm.reset();
  stationIndexInput.value = "";
}

function deleteStation(index) {
  const list = currentStations();
  if (!list[index]) return;

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

  if (!station.name || !station.url) return;

  if (index >= 0) {
    list[index] = station;
  } else {
    list.push(station);
  }

  saveAndNotify();
  clearForm();
  renderStationList();
});

cancelEditBtn.addEventListener("click", clearForm);
resetStationsBtn.addEventListener("click", () => {
  stations = defaultStations();
  saveAndNotify();
  clearForm();
  renderStationList();
});

closeManagerBtn.addEventListener("click", () => {
  appWindow.close();
});

titleDragRegion.addEventListener("mousedown", (event) => {
  if (event.button !== 0 || event.target.closest("button")) return;
  appWindow.startDragging();
});

renderStationList();
