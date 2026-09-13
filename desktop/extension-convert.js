'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { createHash } = require('node:crypto');
const { parseYamlFrontmatter } = require('./extension-compat');
const F = require('./extension-files');

// Deterministic conversion of pure-Markdown Claude command prompts into a
// standalone Agent Skill package the user saves to a chosen project folder
// and loads through the existing inspect/install chain.
//
// Fidelity is deliberately narrow. A command becomes a SKILL.md whose body
// is the original prompt text, with the ORIGINAL command file copied into
// sources/ so copyright and provenance survive verbatim. Host-specific
// semantics are not invented: commands containing shell execution
// fragments (!`…`) or hooks are refused outright; allowed-tools/model
// frontmatter, @file injections and $ARGUMENTS placeholders convert only
// with an explicit "not migrated" note. Nothing is executed while reading.

const CONVERTIBLE_DIR = 'commands';
const FAIL = (message, code = -32602) => { const error = new Error(message); error.rpc = { code, message }; throw error; };

function skillNameFor(commandName) {
  const slug = String(commandName).toLowerCase()
    .replace(/\.md$/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'converted-command';
}

// Returns the list of unmigrated semantics found in a command file, plus a
// boolean for hard refusals (shell execution, bash interpolation, path escape, hooks).
function inspectCommandText(text, frontmatter) {
  const refusals = [];
  const notes = [];
  if (/^\uFEFF?---\r?\n/.test(text) && !frontmatter) refusals.push('命令的 YAML 元数据无效、未闭合或超出解析限制；无法审阅其语义，不予转换');
  if (/!\s*`[^`]*`/.test(text)) refusals.push('命令包含 shell 执行片段（!`…`）；转换器不执行也不迁移它');
  if (/\$\([^\)]+\)/.test(text)) refusals.push('命令包含 bash 插值（$(…)）；转换器不执行也不迁移它');
  if (frontmatter && frontmatter.hooks) refusals.push('命令声明了 hooks；Claude hook 语义没有等价迁移');
  if (frontmatter && frontmatter.agent) refusals.push('命令声明了 agent 行为；Claude agent 语义没有等价迁移');
  if (frontmatter && (frontmatter.allowedTools || frontmatter['allowed-tools'])) notes.push('allowed-tools 权限语义未迁移');
  if (frontmatter?.model) notes.push('model 选择未迁移');
  if (frontmatter?.permissions || frontmatter?.permission) notes.push('permissions 权限语义未迁移');
  if (frontmatter?.context) notes.push('context 上下文注入语义未迁移');
  if (frontmatter?.mode) notes.push('mode 运行模式未迁移');
  for (const match of text.matchAll(/(^|\s)@([\w./-]+)/g)) {
    if (match[2].includes('..') || match[2].startsWith('/')) {
      refusals.push(`命令包含逃逸路径引用 @${match[2]}；不受支持`);
    } else {
      notes.push(`文件引用 @${match[2]} 未迁移（动态注入不存在）`);
    }
  }
  if (/\$ARGUMENTS/i.test(text)) notes.push('$ARGUMENTS 占位符按字面保留；参数注入语义未迁移');
  return { refusals, notes };
}

function createExtensionConverter({ home } = {}) {
  if (!path.isAbsolute(home || '')) throw new Error('extension-convert requires an absolute Home');
  const marketplaces = path.join(home, 'extensions', 'marketplaces');

  function activePackageDir(catalogEntryId) {
    const catalogFile = path.join(home, 'extensions', 'catalog.json');
    let entry;
    try {
      const catalog = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
      entry = catalog?.version === 1 ? catalog.entries.find((item) => item.id === catalogEntryId) : undefined;
    } catch { entry = undefined; }
    if (!entry) FAIL('找不到该扩展', -32004);
    return { entry, pluginDir: path.join(marketplaces, entry.id, 'packages', entry.activeVersion, 'plugin') };
  }

  return {
    // Read-only preview: which commands convert, which are refused, which
    // notes a conversion would carry. The source package is untouched.
    async plan({ entryId }) {
      const { entry, pluginDir } = activePackageDir(entryId);
      const commandsDir = path.join(pluginDir, CONVERTIBLE_DIR);
      const files = fs.existsSync(commandsDir)
        ? (await fsp.readdir(commandsDir)).filter((name) => name.toLowerCase().endsWith('.md')).sort()
        : [];
      const packageSha256 = F.scan(pluginDir).sha256;
      const items = [];
      const usedNames = new Set();
      for (const file of files) {
        const bytes = await fsp.readFile(path.join(commandsDir, file));
        let text = '', invalidUtf8 = false;
        try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
        catch { invalidUtf8 = true; }
        const frontmatter = parseYamlFrontmatter(text);
        const { refusals, notes } = inspectCommandText(text, frontmatter);
        if (invalidUtf8) refusals.push('命令不是有效 UTF-8 文本；为保留原始内容，不予转换');
        const description = typeof frontmatter?.description === 'string' && frontmatter.description.trim()
          ? frontmatter.description.trim()
          : `Converted prompt from ${CONVERTIBLE_DIR}/${file}`;
        const skillName = skillNameFor(file);
        if (usedNames.has(skillName)) refusals.push(`转换后的 Skill 名与其它命令重复（${skillName}）`);
        usedNames.add(skillName);
        items.push({
          command: file,
          skillName,
          status: refusals.length ? 'refused' : 'convertible',
          description,
          sourceSha256: createHash('sha256').update(bytes).digest('hex'),
          refusals,
          notes,
        });
      }
      return {
        version: 1,
        extension: { id: entry.id, name: entry.name, packageSha256 },
        sourceDir: `${CONVERTIBLE_DIR}/`,
        items,
        outputNote: '输出保存到你选择的项目子目录，再通过现有“从项目导入”检查链装载；默认停用。',
      };
    },

    // Writes one standalone skill package per convertible command under
    // outputDir. The original command file is preserved verbatim under
    // sources/; a conversion report carries the source hashes so the
    // original text stays locatable. The source package is never modified.
    async perform({ entryId, outputDir, commands, expectedPackageSha256 }) {
      const { entry, pluginDir } = activePackageDir(entryId);
      const plan = await this.plan({ entryId });
      if (expectedPackageSha256 !== undefined && expectedPackageSha256 !== plan.extension.packageSha256) FAIL('来源包在预览后发生变化；请重新预览转换', -32005);
      if (!outputDir || !path.isAbsolute(outputDir) || outputDir.split(/[/\\]/).some(p => p === '..')) FAIL('请选择一个有效的绝对路径作为输出目录');
      let exists = true;
      try { await fsp.stat(outputDir); } catch { exists = false; }
      if (exists) FAIL('输出目录已存在；请选择一个新目录', -32005);
      const wanted = Array.isArray(commands) && commands.length ? new Set(commands) : null;
      const results = [];
      const reportEntries = [];
      const packageSha256 = plan.extension.packageSha256;
      // Claim the final directory exclusively. A directory created after
      // preflight belongs to its creator, even when it is still empty.
      try { await fsp.mkdir(outputDir); }
      catch (error) {
        if (error.code === 'EEXIST') FAIL('输出目录已存在；请选择一个新目录', -32005);
        throw error;
      }
      try {
        for (const item of plan.items) {
          if (wanted && !wanted.has(item.command)) continue;
          if (item.status === 'refused') {
            results.push({ command: item.command, status: 'refused', detail: item.refusals.join('；') });
            continue;
          }
          const sourcePath = path.join(pluginDir, CONVERTIBLE_DIR, item.command);
          const sourceBytes = await fsp.readFile(sourcePath);
          const originalSha256 = createHash('sha256').update(sourceBytes).digest('hex');
          if (originalSha256 !== item.sourceSha256) FAIL('来源在检查后发生变化；请重新预览转换', -32005);
          const sourceText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(sourceBytes);
          const body = sourceText.replace(/^\uFEFF/, '').replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
          // skills/<name>/ is the layout the existing inspect chain and
          // Kernel discovery recognize.
          const skillDir = path.join(outputDir, 'skills', item.skillName);
          await fsp.mkdir(path.join(skillDir, 'sources'), { recursive: true });
          const skillText = `---\nname: ${item.skillName}\ndescription: >-\n  ${item.description.replace(/\n/g, '\n  ')}\n---\n${body.trimStart()}\n`;
          await fsp.writeFile(path.join(skillDir, 'SKILL.md'), skillText, { encoding: 'utf8', flag: 'wx' });
          // Preserve the exact bytes that were checked, not a second read
          // which could acquire a different revision of the command.
          await fsp.writeFile(path.join(skillDir, 'sources', item.command), sourceBytes, { flag: 'wx' });
          reportEntries.push({
            command: item.command,
            skillName: item.skillName,
            skillDir: path.basename(skillDir),
            sourceExtension: { id: plan.extension.id, name: plan.extension.name },
            packageSha256,
            sourceFile: `${CONVERTIBLE_DIR}/${item.command}`,
            originalSha256,
            unmigrated: item.notes,
            convertedAt: new Date().toISOString(),
          });
          results.push({ command: item.command, status: 'converted', skillName: item.skillName, notes: item.notes });
        }
        if (F.scan(pluginDir).sha256 !== packageSha256) FAIL('来源包在转换时发生变化；请重新预览转换', -32005);
        await fsp.writeFile(path.join(outputDir, 'conversion-report.json'), JSON.stringify({ version: 1, status: 'completed', extension: plan.extension, entries: reportEntries }, null, 2), { encoding: 'utf8', flag: 'wx' });
        return { ok: true, outputDir, results };
      } catch (error) {
        // Do not recursively delete a user-selected path on failure. It may
        // have acquired user files or been replaced since our exclusive claim.
        // Keep partial output explicitly unconfirmed and available for review.
        error.message = `${error.message}；转换未完成，已写入内容保留在 ${outputDir}`;
        error.rpc = { ...(error.rpc || { code: -32000 }), message: error.message, data: { outputDir, partial: true, results } };
        throw error;
      }
    },
  };
}

module.exports = { createExtensionConverter, skillNameFor, inspectCommandText };
