import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import ThemeScript from "../components/ThemeScript";
import { WORKBENCH_STYLE_KEY, WORKBENCH_STYLES, workbenchStylePreference } from "../lib/native-workbench-style";

test("workbench styles accept both saved ids and default safely on malformed storage", () => {
  for (const style of WORKBENCH_STYLES) {
    assert.equal(workbenchStylePreference(style), style);
    assert.equal(workbenchStylePreference(JSON.stringify(style)), style);
  }
  for (const raw of [null, "", "{", "null", "true", "7", '"unknown"', '{"style":"luminous"}', '["luminous"]']) {
    assert.equal(workbenchStylePreference(raw), "minimal", `raw: ${raw}`);
  }
});

function runThemeScript(stored: Record<string, string>, storageDisabled = false) {
  const data = new Map(Object.entries(stored));
  const attributes = new Map<string, string>();
  const styleWrites: string[] = [];
  const element = {
    setAttribute: (key: string, value: string) => { attributes.set(key, value); if (key === "data-workbench-style") styleWrites.push(value); },
    removeAttribute: (key: string) => attributes.delete(key),
    classList: { remove() {}, add() {} },
    dataset: {},
    style: { setProperty() {} },
  };
  runInNewContext(ThemeScript().props.dangerouslySetInnerHTML.__html, {
    document: { documentElement: element },
    window: { matchMedia: () => ({ matches: false }) },
    localStorage: {
      get length() { if (storageDisabled) throw new Error("Storage disabled"); return data.size; },
      key: (index: number) => [...data.keys()][index] ?? null,
      getItem: (key: string) => { if (storageDisabled) throw new Error("Storage disabled"); return data.get(key) ?? null; },
      setItem: (key: string, value: string) => { data.set(key, value); },
      removeItem: (key: string) => { data.delete(key); },
    },
  });
  return { attributes, styleWrites, data };
}

test("first paint reads the saved style without a Minimal intermediate write", () => {
  for (const raw of ["luminous", '"luminous"', '  "luminous"  ']) {
    const { styleWrites, data } = runThemeScript({ [WORKBENCH_STYLE_KEY]: raw });
    assert.deepEqual(styleWrites, ["luminous"]);
    assert.equal(data.get(WORKBENCH_STYLE_KEY), raw);
  }
});

test("first paint retains Minimal for missing, invalid and unavailable storage", () => {
  assert.deepEqual(runThemeScript({}).styleWrites, ["minimal"]);
  assert.deepEqual(runThemeScript({ [WORKBENCH_STYLE_KEY]: '{"style":"luminous"}' }).styleWrites, ["minimal"]);
  assert.deepEqual(runThemeScript({}, true).styleWrites, ["minimal"]);
});

test("legacy storage cannot opt users into a different workbench style", () => {
  const legacyKey = ["deep", "tutor-workbench-style-v1"].join("");
  const { styleWrites, data } = runThemeScript({ [legacyKey]: '"luminous"' });
  assert.deepEqual(styleWrites, ["minimal"]);
  assert.equal(data.has(WORKBENCH_STYLE_KEY), false);
  assert.equal(data.get(legacyKey), '"luminous"');
});
