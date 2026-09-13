export const WORKBENCH_STYLE_KEY = "knorvia-workbench-style-v1";
export const WORKBENCH_STYLES = ["minimal", "luminous"] as const;
export type WorkbenchStyle = (typeof WORKBENCH_STYLES)[number];

/** useLocalPreference writes JSON; bare ids are also safe to read. */
export function workbenchStylePreference(raw: string | null): WorkbenchStyle {
  let value: unknown = raw;
  try { value = JSON.parse(raw ?? ""); } catch { /* A bare id or missing preference. */ }
  return value === "luminous" ? "luminous" : "minimal";
}

/** Runs before theme migration or any other storage access can fail. */
export const WORKBENCH_STYLE_BOOTSTRAP = `
  (function() {
    var style = 'minimal';
    try {
      var raw = localStorage.getItem(${JSON.stringify(WORKBENCH_STYLE_KEY)});
      var value = raw;
      try { value = JSON.parse(raw); } catch (e) {}
      if (value === 'luminous') style = 'luminous';
    } catch (e) { /* Storage may be disabled. */ }
    document.documentElement.setAttribute('data-workbench-style', style);
  })();
`;
