import { stationsSource1 } from "./data/indonesia.js";
import { stationsSource2 } from "./data/international.js";

export const STORAGE_KEY = "classic-radio-stations";
export const PREFERENCES_KEY = "classic-radio-preferences";
export const FAVORITES_KEY = "classic-radio-favorites";

export function defaultStations() {
  return {
    "1": stationsSource1.map((station) => ({ ...station, country: station.country || "Indonesia" })),
    "2": stationsSource2.map((station) => ({ ...station, country: station.country || "International" })),
  };
}

export function loadStoredStations() {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (!stored) return defaultStations();

  try {
    const parsed = JSON.parse(stored);
    if (Array.isArray(parsed["1"]) && Array.isArray(parsed["2"])) return parsed;
  } catch (error) {
    console.warn("Invalid station storage, using defaults.", error);
  }

  return defaultStations();
}

export function persistStations(stations) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stations));
}

export function defaultPreferences() {
  return {
    source: "1",
    stationUrl: "",
    volume: 1,
    muted: false,
    miniMode: false,
  };
}

export function loadPreferences() {
  const stored = localStorage.getItem(PREFERENCES_KEY);
  if (!stored) return defaultPreferences();

  try {
    const parsed = JSON.parse(stored);
    return {
      ...defaultPreferences(),
      ...parsed,
      source: parsed.source === "2" ? "2" : "1",
      volume: clampVolume(parsed.volume),
      muted: Boolean(parsed.muted),
      miniMode: Boolean(parsed.miniMode),
    };
  } catch (error) {
    console.warn("Invalid preferences storage, using defaults.", error);
    return defaultPreferences();
  }
}

export function persistPreferences(preferences) {
  localStorage.setItem(PREFERENCES_KEY, JSON.stringify({
    ...defaultPreferences(),
    ...preferences,
    volume: clampVolume(preferences.volume),
  }));
}

export function loadFavorites() {
  const stored = localStorage.getItem(FAVORITES_KEY);
  if (!stored) return [];

  try {
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed.filter((url) => typeof url === "string") : [];
  } catch (error) {
    console.warn("Invalid favorites storage, using empty list.", error);
    return [];
  }
}

export function persistFavorites(favorites) {
  localStorage.setItem(FAVORITES_KEY, JSON.stringify([...new Set(favorites)]));
}

export function validateStation(station) {
  const name = station.name?.trim() || "";
  const url = station.url?.trim() || "";
  const country = station.country?.trim() || "";

  if (!name) return { valid: false, message: "Nama stasiun wajib diisi." };
  if (!url) return { valid: false, message: "URL streaming wajib diisi." };

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return { valid: false, message: "Format URL streaming tidak valid." };
  }

  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    return { valid: false, message: "URL streaming harus memakai http atau https." };
  }

  return {
    valid: true,
    station: {
      name,
      url,
      country,
    },
  };
}

export function normalizeStationGroups(value) {
  if (!value || !Array.isArray(value["1"]) || !Array.isArray(value["2"])) {
    return null;
  }

  const normalized = { "1": [], "2": [] };
  for (const source of ["1", "2"]) {
    for (const station of value[source]) {
      const result = validateStation(station);
      if (!result.valid) return null;
      normalized[source].push({
        ...result.station,
        country: result.station.country || (source === "1" ? "Indonesia" : "International"),
      });
    }
  }

  return normalized;
}

function clampVolume(value) {
  const volume = Number(value);
  if (!Number.isFinite(volume)) return 1;
  return Math.min(1, Math.max(0, volume));
}
