import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultPreferences,
  loadFavorites,
  loadPreferences,
  normalizeStationGroups,
  persistFavorites,
  persistPreferences,
  validateStation,
} from "./station-store.js";

function mockLocalStorage() {
  const values = new Map();
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
  };
}

test("validateStation accepts http and https stream URLs", () => {
  assert.equal(validateStation({
    name: "Station",
    url: "https://example.com/stream.mp3",
  }).valid, true);
  assert.equal(validateStation({
    name: "Station",
    url: "http://example.com/stream.mp3",
  }).valid, true);
});

test("validateStation rejects empty and unsupported URLs", () => {
  assert.equal(validateStation({ name: "", url: "https://example.com" }).valid, false);
  assert.equal(validateStation({ name: "Station", url: "ftp://example.com/stream" }).valid, false);
  assert.equal(validateStation({ name: "Station", url: "not a url" }).valid, false);
});

test("normalizeStationGroups requires both source groups", () => {
  assert.equal(normalizeStationGroups({ "1": [], "2": [] })?.["1"].length, 0);
  assert.equal(normalizeStationGroups({ "1": [] }), null);
  assert.equal(normalizeStationGroups({ "1": [{ name: "", url: "" }], "2": [] }), null);
});

test("preferences and favorites survive storage roundtrip", () => {
  mockLocalStorage();

  persistPreferences({ source: "2", stationUrl: "https://example.com", volume: 2, muted: true });
  assert.deepEqual(loadPreferences(), {
    ...defaultPreferences(),
    source: "2",
    stationUrl: "https://example.com",
    volume: 1,
    muted: true,
  });

  persistFavorites(["https://a.example", "https://a.example", "https://b.example"]);
  assert.deepEqual(loadFavorites(), ["https://a.example", "https://b.example"]);
});
