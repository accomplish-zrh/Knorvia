import "@testing-library/jest-dom";

// Node 25 exposes an incomplete experimental localStorage global that can shadow
// jsdom's storage. Keep tests deterministic with an in-memory browser-compatible store.
const values = new Map<string, string>();
const testStorage: Storage = {
  get length() { return values.size; },
  clear() { values.clear(); },
  getItem(key) { return values.get(key) ?? null; },
  key(index) { return [...values.keys()][index] ?? null; },
  removeItem(key) { values.delete(key); },
  setItem(key, value) { values.set(String(key), String(value)); },
};

Object.defineProperty(window, "localStorage", { configurable: true, value: testStorage });
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: testStorage });
