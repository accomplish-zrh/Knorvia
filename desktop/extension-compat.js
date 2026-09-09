'use strict';

// Extension format compatibility diagnostics (A19). Read-only analysis of an
// extension directory into a per-component compatibility table. The statuses
// are deliberately conservative: "loadable" means the manifest parsed and the
// layout matches the format, never that the extension has been executed.
// Unverified execution stays unverified unless a caller has run it.

const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const MAX_FILES_SCANNED = 2000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

const STATUS = {
  LOADABLE: 'loadable',
  MISSING_DEPENDENCY: 'missing-dependency',
  PARTIAL: 'convertible-partial',
  UNSUPPORTED: 'unsupported',
  UNVERIFIED: 'unverified-execution',
};

function readIfSmall(file) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) return null;
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
  return fs.readFileSync(file, 'utf8');
}

function parseYamlFrontmatter(text) {
  const match = text.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match || match[1].length > 32768) return null;
  try {
    const fields = YAML.parse(match[1], { maxAliasCount: 0, uniqueKeys: true });
    return fields && typeof fields === 'object' && !Array.isArray(fields) ? fields : null;
  } catch { return null; }
}

function listDirSafe(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).map((entry) => entry.name);
  } catch {
    return [];
  }
}

function analyzeSkillComponent(dir) {
  const skillFile = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(skillFile)) return null;
  let text;
  try { text = readIfSmall(skillFile); } catch { text = null; }
  if (text === null || text === undefined) {
    return { component: 'SKILL.md', format: 'agent-skill', status: STATUS.UNSUPPORTED,
      details: 'SKILL.md is missing, unreadable, or larger than the analysis cap' };
  }
  const frontmatter = parseYamlFrontmatter(text);
  if (!frontmatter || typeof frontmatter.name !== 'string' || !frontmatter.name) {
    return { component: 'SKILL.md', format: 'agent-skill', status: STATUS.UNSUPPORTED,
      details: 'YAML frontmatter with at least a name field is required' };
  }
  const issues = [];
  if (typeof frontmatter.description !== 'string' || !frontmatter.description) {
    return { component: 'SKILL.md', format: 'agent-skill', status: STATUS.UNSUPPORTED, details: 'A non-empty description is required by the Kernel' };
  }
  const allowedTools = Array.isArray(frontmatter['allowed-tools']) ? frontmatter['allowed-tools'] : typeof frontmatter['allowed-tools'] === 'string' ? frontmatter['allowed-tools'].split(/\s+/).filter(Boolean) : undefined;
  return {
    component: 'SKILL.md', format: 'agent-skill', status: STATUS.LOADABLE,
    details: issues.join('; ') || 'frontmatter parsed',
    name: frontmatter.name,
    description: frontmatter.description,
    compatibility: typeof frontmatter.compatibility === 'string' ? frontmatter.compatibility : undefined,
    allowedTools,
    allowedToolsNote: allowedTools
      ? 'allowed-tools describes intended tool use; it is not an authorization grant'
      : undefined,
  };
}

function interpreterForScript(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.ps1') return { runtime: 'powershell', available: process.platform === 'win32' };
  if (ext === '.py') return { runtime: 'python', available: null };
  if (ext === '.sh') return { runtime: 'bash', available: process.platform !== 'win32' };
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return { runtime: 'node', available: null };
  return { runtime: ext.replace('.', '') || 'unknown', available: null };
}

function analyzeScriptComponents(dir) {
  const out = [];
  const scriptDirs = ['scripts', 'bin'];
  let scanned = 0;
  for (const scriptDir of scriptDirs) {
    const full = path.join(dir, scriptDir);
    for (const name of listDirSafe(full)) {
      if (++scanned > 50) return out;
      const file = path.join(full, name);
      let stat;
      try { stat = fs.statSync(file); } catch { continue; }
      if (!stat.isFile()) continue;
      const { runtime, available } = interpreterForScript(name);
      if (available === false) {
        out.push({ component: `${scriptDir}/${name}`, format: 'script', status: STATUS.MISSING_DEPENDENCY,
          details: `requires ${runtime}, which is not available on this platform` });
      } else {
        out.push({ component: `${scriptDir}/${name}`, format: 'script', status: STATUS.UNVERIFIED,
          details: `requires ${runtime}; presence detected by extension only and execution has not been verified` });
      }
    }
  }
  return out;
}

function parseJsonFile(file) {
  let text;
  try { text = readIfSmall(file); } catch { return null; }
  if (text == null) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function analyzeCodexPlugin(dir) {
  const manifestPath = path.join(dir, '.codex-plugin', 'plugin.json');
  if (!fs.existsSync(manifestPath)) return null;
  const manifest = parseJsonFile(manifestPath);
  if (!manifest || typeof manifest !== 'object') {
    return [{ component: '.codex-plugin/plugin.json', format: 'codex-plugin', status: STATUS.UNSUPPORTED,
      details: 'plugin.json is missing, invalid JSON, or larger than the analysis cap' }];
  }
  const out = [{ component: '.codex-plugin/plugin.json', format: 'codex-plugin', status: STATUS.LOADABLE,
    details: 'manifest parsed', name: manifest.name ?? manifest.id }];
  if (manifest.mcpServers || fs.existsSync(path.join(dir, '.mcp.json'))) {
    out.push({ component: 'mcpServers', format: 'codex-plugin-mcp', status: STATUS.UNVERIFIED,
      details: 'MCP servers require a host transport connection; availability depends on the Kernel connection' });
  }
  return out;
}

function analyzeClaudePlugin(dir) {
  const manifestPath = path.join(dir, '.claude-plugin', 'plugin.json');
  if (!fs.existsSync(manifestPath)) return null;
  const manifest = parseJsonFile(manifestPath);
  if (!manifest || typeof manifest !== 'object') {
    return [{ component: '.claude-plugin/plugin.json', format: 'claude-plugin', status: STATUS.UNSUPPORTED,
      details: 'plugin.json is missing, invalid JSON, or larger than the analysis cap' }];
  }
  const out = [{ component: '.claude-plugin/plugin.json', format: 'claude-plugin', status: STATUS.LOADABLE,
    details: 'manifest parsed', name: manifest.name ?? manifest.id }];
  // Claude host-specific components do not map onto the Knorvia Kernel.
  if (manifest.hooks || listDirSafe(path.join(dir, 'hooks')).length) {
    out.push({ component: 'hooks/', format: 'claude-hooks', status: STATUS.UNSUPPORTED,
      details: 'Claude hook semantics have no Knorvia Kernel equivalent; pretending to run them would be dishonest' });
  }
  if (listDirSafe(path.join(dir, 'agents')).length) {
    out.push({ component: 'agents/', format: 'claude-agents', status: STATUS.PARTIAL,
      details: 'static prompt resources can be converted; live agent behaviour is not equivalent and is not claimed' });
  }
  if (listDirSafe(path.join(dir, 'commands')).length) {
    out.push({ component: 'commands/', format: 'claude-commands', status: STATUS.PARTIAL,
      details: 'command prompts can be converted to prompt resources; behaviour needs per-command verification' });
  }
  if (fs.existsSync(path.join(dir, '.mcp.json'))) {
    out.push({ component: '.mcp.json', format: 'mcp', status: STATUS.UNVERIFIED,
      details: 'MCP servers require a host transport connection; initialize/tools/list/call must be verified before claiming support' });
  }
  return out;
}

/**
 * Analyze one extension directory into a compatibility table. Never mutates
 * the source directory and never executes any file it finds.
 */
function analyzeExtension({ dir }) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) {
    throw Object.assign(new Error('dir must be an absolute path'), { category: 'INVALID_ARGUMENT' });
  }
  let stat;
  try { stat = fs.statSync(dir); } catch {
    throw Object.assign(new Error(`extension directory not found: ${dir}`), { category: 'NOT_FOUND' });
  }
  if (!stat.isDirectory()) {
    throw Object.assign(new Error('dir must be a directory'), { category: 'INVALID_ARGUMENT' });
  }
  // The public analyzer is also used directly by the native host. Refuse
  // linked descendants before reading any manifest or script metadata.
  let count = 0;
  const inspect = (folder, depth = 0) => {
    if (depth > 16) throw new Error('Extension nesting exceeds the analysis limit');
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (++count > MAX_FILES_SCANNED) throw new Error('Extension contains too many files');
      const child = path.join(folder, entry.name), st = fs.lstatSync(child);
      if (st.isSymbolicLink()) throw new Error('Linked files are not accepted in extension packages');
      if (st.isDirectory()) inspect(child, depth + 1);
    }
  };
  if (fs.lstatSync(dir).isSymbolicLink()) throw new Error('Linked extension roots are not accepted');
  inspect(dir);
  const components = [];
  const skill = analyzeSkillComponent(dir);
  if (skill) components.push(skill);
  const codex = analyzeCodexPlugin(dir);
  if (codex) components.push(...codex);
  const claude = analyzeClaudePlugin(dir);
  if (claude) components.push(...claude);
  for (const name of listDirSafe(path.join(dir, 'skills'))) {
    const candidate = path.join(dir, 'skills', name);
    if (!fs.statSync(candidate).isDirectory()) continue;
    const nested = analyzeSkillComponent(candidate);
    if (nested) components.push({ ...nested, component: `skills/${name}/SKILL.md` });
  }
  components.push(...analyzeScriptComponents(dir));

  if (!components.length) {
    return {
      dir,
      format: 'unknown',
      status: STATUS.UNSUPPORTED,
      components: [],
      summary: 'no recognizable extension format found (Agent Skill SKILL.md, .codex-plugin, .claude-plugin)',
    };
  }
  const hasUnsupported = components.some((entry) => entry.status === STATUS.UNSUPPORTED);
  const hasMissing = components.some((entry) => entry.status === STATUS.MISSING_DEPENDENCY);
  const hasLoadable = components.some((entry) => entry.status === STATUS.LOADABLE);
  const status = hasLoadable && hasUnsupported ? STATUS.PARTIAL
    : hasMissing && !hasUnsupported ? STATUS.MISSING_DEPENDENCY
      : hasUnsupported && !hasLoadable ? STATUS.UNSUPPORTED
        : hasLoadable ? STATUS.LOADABLE : STATUS.UNVERIFIED;
  return {
    dir,
    format: skill ? 'agent-skill' : codex ? 'codex-plugin' : 'claude-plugin',
    status,
    components,
    summary: 'analysis only: loadable manifests do not prove execution; execution is verified separately by a real Kernel call',
  };
}

const ANALYZE = 'workspace/extensions/analyze';

const HANDLERS = {
  [ANALYZE]: async (params) => analyzeExtension({ dir: params?.dir }),
};

module.exports = {
  HANDLERS,
  METHODS: [ANALYZE],
  STATUS,
  analyzeExtension,
  parseYamlFrontmatter,
};
