import { stationsSource1 } from "./data/indonesia.js";
import { stationsSource2 } from "./data/international.js";

export const STORAGE_KEY = "classic-radio-stations";

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
