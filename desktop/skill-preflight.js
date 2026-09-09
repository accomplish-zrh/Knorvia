'use strict';

// Skill dependency preflight (KNORVIA-NIGHT B12). Reads a skill directory and
// reports dependency facts with fix hints. It never fixes, installs, or
// downloads anything by itself.

const fs = require('node:fs');
const path = require('node:path');

// Minimal, safe frontmatter slice: only what a supportable skill needs.
function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return { error: '缺少 frontmatter（--- 块）' };
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (pair) fields[pair[1].trim()] = pair[2].trim().replace(/^["']|["']$/g, '');
  }
  return { fields };
}

function which(command) {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const suffix = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of dirs) {
    for (const ext of suffix) {
      const candidate = path.join(dir, command + ext);
      try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch {}
    }
  }
  return null;
}

function analyzeSkillDir(dir, { modelProfiles } = {}) {
  const issues = [];
  const checks = [];
  let frontmatter = {};
  const skillFile = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(skillFile)) {
    issues.push({ code: 'missing-skill-md', message: '缺少 SKILL.md', fix: '按技能格式补充 SKILL.md（frontmatter: name/description）。' });
  } else {
    const parsed = parseFrontmatter(fs.readFileSync(skillFile, 'utf8'));
    if (parsed.error) issues.push({ code: 'bad-frontmatter', message: parsed.error, fix: '补充 --- frontmatter 块。' });
    else {
      frontmatter = parsed.fields;
      if (!frontmatter.name) issues.push({ code: 'missing-name', message: 'frontmatter 缺少 name', fix: '在 frontmatter 中填写技能名。' });
      if (!frontmatter.description) issues.push({ code: 'missing-description', message: 'frontmatter 缺少 description', fix: '在 frontmatter 中填写触发描述。' });
    }
  }
  const references = path.join(dir, 'references');
  if (fs.existsSync(references)) {
    const files = fs.readdirSync(references).filter(name => !name.startsWith('.'));
    checks.push({ name: 'references', ok: files.length > 0, detail: files.length ? `${files.length} 个引用文件` : 'references 目录为空' });
  } else {
    checks.push({ name: 'references', ok: true, detail: '无 references 目录（可选）' });
  }
  // MCP dependencies declared in frontmatter (metadata JSON with mcpServers).
  const mcpRaw = frontmatter.metadata;
  if (mcpRaw && mcpRaw.includes('mcp')) {
    try {
      const metadata = JSON.parse(mcpRaw);
      const servers = metadata?.mcpServers ?? metadata?.openclaw?.mcpServers ?? {};
      for (const [name, server] of Object.entries(servers)) {
        if (server?.command) {
          const resolved = path.isAbsolute(server.command) ? (fs.existsSync(server.command) ? server.command : null) : which(server.command);
          checks.push({
            name: `mcp:${name}`,
            ok: Boolean(resolved),
            detail: resolved ? `stdio 命令可用：${resolved}` : `找不到命令 ${server.command}`,
            ...(resolved ? {} : { fix: '安装该 MCP 依赖或在配置中使用绝对路径。' }),
          });
          if (!resolved) issues.push({ code: 'mcp-command-missing', message: `MCP ${name} 的命令不可用`, fix: `安装 ${server.command} 或改用绝对路径。` });
        } else if (server?.url) {
          checks.push({ name: `mcp:${name}`, ok: true, detail: `HTTP MCP：${server.url}` });
        }
      }
    } catch {
      issues.push({ code: 'bad-metadata', message: 'frontmatter metadata 不是有效 JSON', fix: '修正 metadata JSON。' });
    }
  }
  if (frontmatter['cli-dependencies'] || frontmatter.cliDependencies) {
    for (const cli of String(frontmatter['cli-dependencies'] ?? frontmatter.cliDependencies).split(/[,\s]+/).filter(Boolean)) {
      const resolved = which(cli);
      checks.push({ name: `cli:${cli}`, ok: Boolean(resolved), detail: resolved ?? 'PATH 上找不到', ...(resolved ? {} : { fix: `安装官方 ${cli} CLI 后重试；缺失时相关能力必须保持禁用。` }) });
      if (!resolved) issues.push({ code: 'cli-missing', message: `依赖的 CLI ${cli} 不存在`, fix: `安装官方 ${cli} CLI；不要伪造其输出。` });
    }
  }
  if (modelProfiles !== undefined) {
    checks.push({ name: 'model-profiles', ok: modelProfiles > 0, detail: modelProfiles > 0 ? `${modelProfiles} 个模型连接` : '未配置模型', ...(modelProfiles > 0 ? {} : { fix: '配置模型连接后，生成类技能才能运行；不要在无模型时伪生成。' }) });
  }
  return {
    dir,
    name: frontmatter.name ?? path.basename(dir),
    loadable: issues.length === 0,
    issues,
    checks,
  };
}

module.exports = { analyzeSkillDir, parseFrontmatter, which };
