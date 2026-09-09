"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { analyzeExtension, parseYamlFrontmatter, STATUS } = require("../extension-compat");

function makeDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "knorvia-ext-"));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return dir;
}

test("pure agent skill with name and description is loadable", () => {
  const dir = makeDir({
    "SKILL.md": "---\nname: demo-skill\ndescription: A demo skill\n---\n\n# Demo\nInstructions body.\n",
  });
  const result = analyzeExtension({ dir });
  assert.equal(result.format, "agent-skill");
  assert.equal(result.status, STATUS.LOADABLE);
  assert.equal(result.components[0].name, "demo-skill");
});

test("bash scripts report missing dependency on Windows and unverified elsewhere", () => {
  const dir = makeDir({
    "SKILL.md": "---\nname: scripted\ndescription: uses bash\n---\nbody\n",
    "scripts/run.sh": "#!/usr/bin/env bash\necho hi\n",
    "scripts/tool.ps1": "Write-Output hi\n",
  });
  const result = analyzeExtension({ dir });
  const sh = result.components.find((entry) => entry.component === "scripts/run.sh");
  const ps1 = result.components.find((entry) => entry.component === "scripts/tool.ps1");
  if (process.platform === "win32") {
    assert.equal(sh.status, STATUS.MISSING_DEPENDENCY);
    assert.equal(ps1.status, STATUS.UNVERIFIED);
  } else {
    assert.equal(sh.status, STATUS.UNVERIFIED);
  }
});

test("claude plugin with hooks is honest: manifest loadable, hooks unsupported", () => {
  const dir = makeDir({
    ".claude-plugin/plugin.json": JSON.stringify({ name: "claude-ext" }),
    "hooks/pre_tool_use.sh": "echo hook\n",
    "commands/greet.md": "Say hello\n",
  });
  const result = analyzeExtension({ dir });
  const hooks = result.components.find((entry) => entry.format === "claude-hooks");
  const commands = result.components.find((entry) => entry.format === "claude-commands");
  assert.equal(hooks.status, STATUS.UNSUPPORTED);
  assert.equal(commands.status, STATUS.PARTIAL);
  assert.equal(result.status, STATUS.PARTIAL, "mixed honest statuses roll up to partial");
});

test("codex plugin parses and flags mcp servers as unverified transport", () => {
  const dir = makeDir({
    ".codex-plugin/plugin.json": JSON.stringify({ name: "codex-ext", mcpServers: [{ name: "x" }] }),
  });
  const result = analyzeExtension({ dir });
  const mcp = result.components.find((entry) => entry.format === "codex-plugin-mcp");
  assert.equal(result.components[0].status, STATUS.LOADABLE);
  assert.equal(mcp.status, STATUS.UNVERIFIED);
});

test("unknown directory reports unsupported without pretending", () => {
  const dir = makeDir({ "readme.txt": "nothing here" });
  const result = analyzeExtension({ dir });
  assert.equal(result.format, "unknown");
  assert.equal(result.status, STATUS.UNSUPPORTED);
});

test("relative dir and missing paths are rejected", () => {
  assert.throws(() => analyzeExtension({ dir: "relative/path" }));
  assert.throws(() => analyzeExtension({ dir: path.join(os.tmpdir(), "knorvia-missing-ext-dir") }));
});

test("frontmatter parser reads lists and quoted values", () => {
  const fields = parseYamlFrontmatter("---\nname: 'quoted'\nallowed-tools:\n  - exec_command\n  - apply_patch\n---\nbody");
  assert.equal(fields.name, "quoted");
  assert.deepEqual(fields["allowed-tools"], ["exec_command", "apply_patch"]);
});
