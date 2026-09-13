'use strict';

// Curated capability catalog (KNORVIA-NIGHT B06/B12). A small, honest list:
// every entry states whether it is built-in, needs installation, needs
// configuration, or is unavailable. Preflight reports dependency facts with
// fix hints but never installs anything by itself.

const fs = require('node:fs');
const path = require('node:path');
const { resolveBinaries } = require('./media-frame-worker');
const { analyzeSkillDir } = require('./skill-preflight');
const fail = (message, code = -32602) => { const error = new Error(message); error.rpc = { code, message }; throw error; };

// Entries are declarative. `check` resolves the live status on every listing;
// nothing here launches installers or downloads.
const ENTRIES = [
  {
    id: 'learning-pack',
    name: '学习基础包（导学/逐题练习/错题复习）',
    category: 'learning',
    description: '版本化讲义与题库、先作答后反馈的逐题练习、错题与到期复习；来源可核对，学习记录可续接。',
    kind: 'builtin',
    check: async () => ({ status: 'builtin' }),
  },
  {
    id: 'creative-brief',
    name: '从资料到作品（简报与评审）',
    category: 'creative',
    description: '固定资料来源，明确受众、作品目标与逐项验收要求；关联实际作品和评审记录，支持继续修改。',
    kind: 'builtin',
    check: async () => ({ status: 'builtin' }),
  },
  {
    id: 'media-edit',
    name: '资料库视频剪辑与导出',
    category: 'creative',
    description: '已有素材导入剪辑工程，帧级裁剪、旋转镜像、字幕轨并导出回资料库（本地 FFmpeg，无模型费用）。',
    kind: 'builtin',
    check: async ({ ffmpeg }) => ffmpeg.ok ? { status: 'builtin' } : { status: 'unavailable', detail: ffmpeg.detail, fix: ffmpeg.fix },
  },
  {
    id: 'remotion-best-practices',
    name: 'Remotion 最佳实践技能（4.0.522）',
    category: 'creative',
    description: '内置技能包，指导按需使用 Remotion 工作流；保留原视频工作台与文章可选流程。',
    kind: 'builtin',
    check: async ({ home }) => fs.existsSync(path.join(home, 'state', 'kernel', 'skills', 'remotion-best-practices'))
      ? { status: 'builtin' }
      : { status: 'needs-install', detail: '技能目录不存在（可能被移除）。可用桌面扩展管理器从项目内 ZIP 重新导入。' },
  },
  {
    id: 'subtitles',
    name: '本地字幕转写与校对',
    category: 'creative',
    description: 'whisper.cpp 本地转写剪辑音频、导入导出 SRT、逐条校对；无远端费用。',
    kind: 'builtin',
    check: async ({ whisper }) => whisper.ok ? { status: 'builtin' } : { status: 'needs-config', detail: whisper.detail, fix: whisper.fix },
  },
  {
    id: 'openmaic-course',
    name: 'OpenMAIC 式课程切片（Knorvia schema）',
    category: 'learning',
    description: '确定性课程 Artifact（模块/课时/练习块 + 来源引用）的保存、校验与渲染；灵感注明 OpenMAIC v1.0.1 (MIT)，不导入其代码。',
    kind: 'builtin',
    check: async () => ({ status: 'builtin' }),
  },
  {
    id: 'image-ops',
    name: '资料库图片本地加工',
    category: 'creative',
    description: '裁切、缩放、格式转换后另存为新版本；固定来源与命令事实，CLI 与创作台同库。',
    kind: 'builtin',
    check: async ({ ffmpeg }) => ffmpeg.ok ? { status: 'builtin' } : { status: 'unavailable', detail: ffmpeg.detail, fix: ffmpeg.fix },
  },
  {
    id: 'article-video',
    name: '文章转视频（可选流程）',
    category: 'creative',
    description: '默认关闭的可选附加流程；需要时在创作台显式开启。',
    kind: 'builtin',
    check: async () => ({ status: 'builtin', detail: '可选流程，默认关闭。' }),
  },
  {
    id: 'openmaic-skill-package',
    name: 'OpenMAIC 官方技能包（需安装）',
    category: 'learning',
    description: 'THU-MAIC/OpenMAIC v1.0.1（根 MIT）的 skills/openmaic SOP 技能；packages/mathml2omml 为 LGPL，不随包分发。已按固定提交只获取 skills/openmaic 子目录（git trees API），不受整仓 24MB 上限限制。',
    kind: 'needs-install',
    source: { type: 'github', repository: 'THU-MAIC/OpenMAIC', tag: 'v1.0.1', commit: 'f50a25644c9c3893503cf0727ccf613c0ce1e748', subdirectory: 'skills/openmaic' },
    check: async ({ extensionManager }) => {
      const installed = await findExtension(extensionManager, 'openmaic');
      if (installed) return { status: installed.enabled ? 'builtin' : 'needs-config', detail: installed.enabled ? '已安装并启用。' : '已安装但未启用。' };
      return { status: 'needs-install', detail: '未安装。通过扩展管理器用固定 commit 导入；夜班不自动安装。' };
    },
  },
];

async function findExtension(extensionManager, keyword) {
  if (!extensionManager) return null;
  const { entries } = await extensionManager.handlers['extension/list']().catch(() => ({ entries: [] }));
  return entries.find(entry => entry.name.toLowerCase().includes(keyword)) ?? null;
}

async function checkWhisper({ home }) {
  // The whisper.cpp program/model is configured in the desktop settings file;
  // its absence means transcription stays disabled instead of pretending.
  const candidates = [
    path.join(home, 'settings', 'media.json'),
    path.join(home, 'settings', 'studio.json'),
  ];
  for (const file of candidates) {
    try {
      const config = JSON.parse(fs.readFileSync(file, 'utf8'));
      const program = config?.whisper?.program || config?.subtitles?.program;
      const model = config?.whisper?.model || config?.subtitles?.model;
      if (program && model) return { ok: true };
      if (program || model) return { ok: false, detail: 'whisper 配置不完整。', fix: '在设置中同时指定 whisper.cpp 程序与模型路径。' };
    } catch {}
  }
  return { ok: false, detail: '尚未配置 whisper.cpp。', fix: '在设置 → 媒体中配置本地 whisper.cpp 程序与模型后再启用转写。' };
}

function createCuratedCatalog({ home, library, studio, extensionManager, rpc } = {}) {
  if (!path.isAbsolute(home || '')) throw new Error('Catalog requires an absolute Home');

  async function facts() {
    let ffmpeg = { ok: false, detail: '未找到 FFmpeg/ffprobe。', fix: '在设置中指定 FFmpeg 目录，或安装 FFmpeg 后重试。' };
    try { resolveBinaries(); ffmpeg = { ok: true }; } catch (error) { ffmpeg.detail = error.rpc?.message || error.message; }
    const [whisper, models] = await Promise.all([
      checkWhisper({ home }),
      (async () => {
        try { const list = await studio.handlers['studio/models'](); return { ok: Array.isArray(list?.profiles) && list.profiles.length > 0, count: list?.profiles?.length ?? 0 }; }
        catch { return { ok: false, count: 0 }; }
      })(),
    ]);
    return { home, ffmpeg, whisper, models };
  }

  async function list() {
    const context = await facts();
    const entries = [];
    for (const entry of ENTRIES) {
      const result = await entry.check(context).catch(error => ({ status: 'unavailable', detail: error.rpc?.message || error.message }));
      entries.push({
        id: entry.id,
        name: entry.name,
        category: entry.category,
        description: entry.description,
        kind: entry.kind,
        ...(entry.source ? { source: entry.source } : {}),
        status: result.status,
        ...(result.detail ? { detail: result.detail } : {}),
        ...(result.fix ? { fix: result.fix } : {}),
      });
    }
    return { entries, context: { ffmpeg: context.ffmpeg.ok, whisper: context.whisper.ok, modelProfiles: context.models.count } };
  }

  const commands = {
    'catalog/list': list,
    'catalog/preflight': async params => {
      const entry = ENTRIES.find(item => item.id === params.id);
      if (!entry) fail('精选目录里没有这个能力', -32004);
      const context = await facts();
      const state = await entry.check(context).catch(error => ({ status: 'unavailable', detail: error.rpc?.message || error.message }));
      const checks = [];
      checks.push({ name: 'ffmpeg', ok: context.ffmpeg.ok, ...(context.ffmpeg.detail ? { detail: context.ffmpeg.detail } : {}), ...(context.ffmpeg.ok ? {} : { fix: context.ffmpeg.fix }) });
      if (entry.category === 'learning') {
        checks.push({ name: 'model-profiles', ok: context.models.ok, detail: context.models.ok ? `${context.models.count} 个已配置模型连接` : '未配置模型；生成类步骤会明确拒绝，不会伪生成。', fix: '在设置 → 模型连接中配置后再使用生成类功能。' });
      }
      if (entry.id === 'subtitles') {
        checks.push({ name: 'whisper', ok: context.whisper.ok, ...(context.whisper.detail ? { detail: context.whisper.detail } : {}), ...(context.whisper.ok ? {} : { fix: context.whisper.fix }) });
      }
      if (entry.id === 'remotion-best-practices') {
        const dir = path.join(home, 'state', 'kernel', 'skills', 'remotion-best-practices');
        const analysis = fs.existsSync(dir) ? analyzeSkillDir(dir, { modelProfiles: context.models.count }) : { loadable: false, issues: [{ code: 'missing-skill-md', message: '技能目录不存在', fix: '用扩展管理器从项目内 ZIP 重新导入。' }], checks: [] };
        checks.push({ name: 'skill-analysis', ok: analysis.loadable, detail: analysis.loadable ? `技能 ${analysis.name} 可加载` : analysis.issues.map(issue => issue.message).join('；'), fix: analysis.loadable ? undefined : '用扩展管理器从项目内 ZIP 重新导入。' });
      }
      if (entry.id === 'openmaic-skill-package') {
        const installed = await findExtension(extensionManager, 'openmaic');
        checks.push({ name: 'extension', ok: Boolean(installed), detail: installed ? `已安装（启用 ${installed.enabled}）` : '未安装；按 source 中的固定 commit 手动导入。' });
      }
      if (entry.id === 'media-edit' || entry.id === 'image-ops') {
        checks.push({ name: 'library', ok: Boolean(library), detail: library ? '资料库就绪' : '资料库不可用' });
      }
      if (entry.id === 'learning-pack') {
        checks.push({ name: 'rpc', ok: typeof rpc === 'function', detail: typeof rpc === 'function' ? '任务存储连接就绪' : '仅资料库模式，无任务存储' });
      }
      return { id: entry.id, status: state.status, ...(state.detail ? { detail: state.detail } : {}), checks };
    },
  };

  const toolDescriptors = () => [
    { name: 'catalog_list', source: 'catalog', description: 'List the curated Knorvia capabilities with honest status: builtin / needs-install / needs-config / unavailable. Prefer these before inventing new tooling.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
    { name: 'catalog_preflight', source: 'catalog', description: 'Run dependency preflight for one catalog capability (FFmpeg, whisper, model connections, skill files). Returns checks with fix hints; never installs anything automatically.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false } },  ];

  async function callTool(name, params = {}) {
    if (name === 'catalog_list') return commands['catalog/list'](params);
    if (name === 'catalog_preflight') return commands['catalog/preflight'](params);
    return undefined;
  }

  return { commands, toolDescriptors, callTool, facts, list };
}

module.exports = { createCuratedCatalog, ENTRIES };
