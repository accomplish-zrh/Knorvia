'use strict';

// Source-grounded creative brief + delivery review. A thin Kernel-callable
// tool: deterministic validation and versioned library writes only — no model
// calls and no second agent loop live here. Model-authored briefs arrive
// through the Kernel; this service checks every claim against pinned source
// text and every delivery review against real, non-empty library outputs.
//
// Evidence contract: a brief pins each source to an immutable sha256 version.
// Creating verifies line+quote against the actual bytes; reading re-checks the
// pins so outdated sources are visible instead of being presented as current.
// Reviews are append-only, idempotent by reviewId, and CAS-written so a
// concurrent review never silently overwrites another.

const crypto = require('node:crypto');
const { createDomainArtifacts, fail, text, recordPath } = require('./domain-artifacts');

const BRIEF_PREFIX = 'creative/简报/';
const LEARNING_PREFIX = 'learning/';
const LEARNING_KINDS = ['lecture', 'quiz', 'session', 'practice-session', 'course'];
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const OUTCOMES = ['pass', 'needs-work', 'not-checked'];
const MAX_REFS = 10;
const MAX_LEARNING_REFS = 20;
const MAX_CLAIMS = 200;
const MAX_CRITERIA = 100;
const MAX_OUTLINE = 200;
const MAX_EVALUATIONS = 200;
const MAX_REVIEWS = 100;

const nowIso = () => new Date().toISOString();
const sha256Hex = value => crypto.createHash('sha256').update(value).digest('hex');
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
    return out;
  }
  return value;
}
const fingerprintOf = value => sha256Hex(JSON.stringify(canonical(value)));

function requireId(value, name) {
  if (typeof value !== 'string' || !ID_RE.test(value.trim())) fail(`${name} 必须是 1–64 位字母、数字、下划线或连字符`);
  return value.trim();
}
function optionalSha(value, name) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !SHA_RE.test(value)) fail(`${name} 必须是 sha256`);
  return value;
}
function normalizeRefs(refs, name, { optional = false, max = MAX_REFS } = {}) {
  if (refs === undefined || refs === null) { if (optional) return []; fail(`${name} 至少需要 1 项`); }
  if (!Array.isArray(refs) || !refs.length) fail(`${name} 至少需要 1 项`);
  if (refs.length > max) fail(`${name} 最多 ${max} 项，请拆分简报而不是被静默截断`);
  const seen = new Set();
  return refs.map((ref, index) => {
    if (!ref || typeof ref !== 'object' || typeof ref.id !== 'string' || !ref.id.trim()) fail(`${name} 第 ${index + 1} 项需要 id`);
    const id = ref.id.trim();
    if (seen.has(id)) fail(`${name} 不能重复引用同一份资料`);
    seen.add(id);
    return { id, version: optionalSha(ref.version, `${name} version`) };
  });
}
function normalizeClaims(claims) {
  if (!Array.isArray(claims) || !claims.length) fail('claims 至少需要 1 条，并各自带原文证据');
  if (claims.length > MAX_CLAIMS) fail(`claims 最多 ${MAX_CLAIMS} 条`);
  const ids = new Set();
  return claims.map((claim, index) => {
    if (!claim || typeof claim !== 'object') fail(`第 ${index + 1} 条主张无效`);
    const id = claim.id === undefined || claim.id === null ? `c${index + 1}` : text(claim.id, `第 ${index + 1} 条主张 id`, 64);
    if (ids.has(id)) fail('主张 id 不能重复');
    ids.add(id);
    const evidence = claim.evidence;
    if (!evidence || typeof evidence !== 'object') fail(`第 ${index + 1} 条主张需要 evidence`);
    if (!Number.isSafeInteger(evidence.line) || evidence.line < 1) fail(`第 ${index + 1} 条主张证据需要有效行号`);
    return {
      id,
      text: text(claim.text, `第 ${index + 1} 条主张 text`, 1000),
      evidence: {
        libraryId: text(evidence.libraryId, 'evidence.libraryId', 200),
        version: optionalSha(evidence.version, 'evidence.version'),
        line: evidence.line,
        quote: text(evidence.quote, 'evidence.quote', 400),
      },
    };
  });
}
function normalizeCriteria(criteria) {
  if (!Array.isArray(criteria) || !criteria.length) fail('criteria 至少需要 1 项可验收要求');
  if (criteria.length > MAX_CRITERIA) fail(`criteria 最多 ${MAX_CRITERIA} 项`);
  const ids = new Set();
  return criteria.map((criterion, index) => {
    if (!criterion || typeof criterion !== 'object') fail(`第 ${index + 1} 项验收要求无效`);
    const id = text(criterion.id, `验收项 ${index + 1} id`, 64);
    if (ids.has(id)) fail('验收项 id 不能重复');
    ids.add(id);
    return { id, description: text(criterion.description, `验收项 ${id} 描述`, 500) };
  });
}
function normalizeOutline(outline, claimIds) {
  if (outline === undefined || outline === null) return [];
  if (!Array.isArray(outline)) fail('outline 必须是数组');
  if (outline.length > MAX_OUTLINE) fail(`outline 最多 ${MAX_OUTLINE} 项`);
  return outline.map((item, index) => {
    if (!item || typeof item !== 'object') fail(`大纲第 ${index + 1} 项无效`);
    const refs = item.claimIds ?? [];
    if (!Array.isArray(refs)) fail('claimIds 必须是数组');
    const seen = new Set();
    const mapped = refs.map(id => {
      const value = typeof id === 'string' ? id.trim() : '';
      if (!claimIds.has(value)) fail(`大纲引用了不存在的主张 ${id}`);
      if (seen.has(value)) fail('同一大纲项不能重复引用同一主张');
      seen.add(value);
      return value;
    });
    return { title: text(item.title, `大纲第 ${index + 1} 项 title`, 200), summary: text(item.summary, `大纲第 ${index + 1} 项 summary`, 1000), claimIds: mapped };
  });
}
function normalizeEvaluations(evaluations) {
  if (!Array.isArray(evaluations) || !evaluations.length) fail('evaluations 至少需要 1 项');
  if (evaluations.length > MAX_EVALUATIONS) fail(`evaluations 最多 ${MAX_EVALUATIONS} 项`);
  return evaluations.map((evaluation, index) => {
    if (!evaluation || typeof evaluation !== 'object') fail(`第 ${index + 1} 项评审无效`);
    const criterionId = text(evaluation.criterionId, 'criterionId', 64);
    if (!OUTCOMES.includes(evaluation.outcome)) fail('outcome 必须是 pass、needs-work 或 not-checked');
    const outputId = evaluation.outputId === undefined || evaluation.outputId === null ? null : text(evaluation.outputId, 'outputId', 200);
    return { criterionId, outcome: evaluation.outcome, note: text(evaluation.note, `验收项 ${criterionId} 的 note`, 1000), outputId };
  });
}

function createCreativeBrief({ library } = {}) {
  if (!library?.handlers) throw new Error('Creative brief requires the personal library');
  const helper = createDomainArtifacts(library);

  async function loadBrief(path) {
    try { return await helper.read(path, 'creative-brief'); }
    catch (error) { if (error.rpc?.code === -32004) return null; throw error; }
  }
  async function requireBrief(path) {
    const brief = await loadBrief(path);
    if (!brief) fail('找不到这份简报', -32004);
    return brief;
  }
  async function currencyMap(refs) {
    const list = (refs ?? []).filter(ref => ref?.libraryId && ref?.version).map(ref => ({ libraryId: ref.libraryId, version: ref.version }));
    if (!list.length) return {};
    const result = await helper.currency(list);
    return Object.fromEntries(result.map(item => [`${item.libraryId}@${item.version}`, item.evidenceStatus]));
  }
  function reviewOutputCurrency(brief) {
    return currencyMap((brief.reviews ?? []).flatMap(review => review.outputRefs ?? []));
  }
  function publicBrief(brief, sourceStatus, outputStatus) {
    const status = sourceStatus ?? {};
    const out = outputStatus ?? {};
    const reviews = (brief.reviews ?? []).map(review => {
      const outputRefs = (review.outputRefs ?? []).map(ref => ({ ...ref, status: out[`${ref.libraryId}@${ref.version}`] ?? 'unknown' }));
      const allCurrent = outputRefs.length > 0 && outputRefs.every(ref => ref.status === 'current')
        && [...(brief.sourceRefs ?? []), ...(brief.learningRefs ?? [])].every(ref => status[`${ref.libraryId}@${ref.version}`] === 'current');
      const allPass = (review.evaluations ?? []).every(item => item.outcome === 'pass');
      const effectiveStatus = review.status !== 'ready' ? 'revision-needed' : allCurrent && allPass ? 'ready' : 'needs-review';
      return { reviewId: review.reviewId, at: review.at, reviewer: review.reviewer, status: review.status, effectiveStatus, outputRefs, evaluations: review.evaluations ?? [] };
    });
    return {
      kind: brief.kind, schemaVersion: brief.schemaVersion, requestId: brief.requestId,
      path: brief.path, sha256: brief.sha256, revision: brief.revision,
      title: brief.title, audience: brief.audience, objective: brief.objective, format: brief.format,
      authorship: brief.authorship, status: reviews.length ? reviews[reviews.length - 1].effectiveStatus : (brief.status ?? 'draft'),
      createdAt: brief.createdAt, updatedAt: brief.updatedAt,
      sourceRefs: (brief.sourceRefs ?? []).map(ref => ({ ...ref, evidenceStatus: status[`${ref.libraryId}@${ref.version}`] ?? 'unknown' })),
      claims: brief.claims ?? [], criteria: brief.criteria ?? [], outline: brief.outline ?? [],
      learningRefs: (brief.learningRefs ?? []).map(ref => ({ ...ref, evidenceStatus: status[`${ref.libraryId}@${ref.version}`] ?? 'unknown' })),
      learningNote: (brief.learningRefs ?? []).length ? '关联学习资料不等于已掌握' : undefined,
      reviews,
    };
  }

  async function resolveLearningRefs(refs) {
    if (!refs.length) return [];
    const entries = await helper.list(LEARNING_PREFIX);
    const result = [];
    for (const ref of refs) {
      const entry = entries.find(item => item.id === ref.id && !item.folder);
      if (!entry) fail('找不到引用的学习资料', -32004);
      const versions = await library.handlers['library/versions']({ id: entry.id });
      const version = ref.version ?? entry.sha256;
      if (!versions.some(item => item.sha256 === version)) fail('引用的学习资料版本不存在');
      const loaded = await helper.readVersion(entry.id, version);
      let kind;
      try { kind = JSON.parse(loaded.text)?.kind; } catch { kind = undefined; }
      if (!LEARNING_KINDS.includes(kind)) fail('引用的不是真实学习成果（讲义/练习/会话/课程）');
      result.push({ libraryId: entry.id, version, path: entry.path, name: entry.name, kind, mastery: 'not-assessed' });
    }
    return result;
  }

  async function createBrief(params) {
    const requestId = requireId(params.requestId, 'requestId');
    const title = text(params.title, 'title', 200);
    const audience = text(params.audience, 'audience', 200);
    const objective = text(params.objective, 'objective', 2000);
    const format = text(params.format, 'format', 120);
    if (!['agent', 'user'].includes(params.authorship)) fail('authorship 必须是 agent 或 user');
    const sourceInput = normalizeRefs(params.sourceRefs, 'sourceRefs');
    const claimsInput = normalizeClaims(params.claims);
    const criteriaInput = normalizeCriteria(params.criteria);
    const claimIds = new Set(claimsInput.map(claim => claim.id));
    const outlineInput = normalizeOutline(params.outline, claimIds);
    const learningInput = normalizeRefs(params.learningRefs, 'learningRefs', { optional: true, max: MAX_LEARNING_REFS });
    const fingerprint = fingerprintOf({ kind: 'creative-brief-create', requestId, title, audience, objective, format, authorship: params.authorship, sourceRefs: sourceInput, claims: claimsInput, criteria: criteriaInput, outline: outlineInput, learningRefs: learningInput });
    const path = `${BRIEF_PREFIX}${requestId}.json`;

    const existing = await loadBrief(path);
    if (existing) {
      if (existing.fingerprint !== fingerprint) fail('requestId 已用于不同的简报参数', -32602);
      return { ...publicBrief(existing, await currencyMap([...(existing.sourceRefs ?? []), ...(existing.learningRefs ?? [])]), await reviewOutputCurrency(existing)), duplicate: true };
    }

    const sourceRefs = await helper.pinSources(sourceInput);
    const claims = [];
    for (const claim of claimsInput) claims.push({ id: claim.id, text: claim.text, evidence: await helper.verifyEvidence(claim.evidence, sourceRefs) });
    const learningRefs = await resolveLearningRefs(learningInput);
    const record = {
      schemaVersion: 1, kind: 'creative-brief', requestId, fingerprint,
      title, audience, objective, format, authorship: params.authorship, status: 'draft',
      revision: 0, createdAt: nowIso(), updatedAt: nowIso(),
      sourceRefs, claims, criteria: criteriaInput, outline: outlineInput, learningRefs, reviews: [],
    };
    let written;
    try {
      written = await helper.write(path, record);
    } catch (error) {
      if (error.rpc?.code !== -32005) throw error;
      const current = await loadBrief(path);
      if (!current) throw error;
      if (current.fingerprint !== fingerprint) fail('requestId 已用于不同的简报参数', -32602);
      return { ...publicBrief(current, await currencyMap([...(current.sourceRefs ?? []), ...(current.learningRefs ?? [])]), await reviewOutputCurrency(current)), duplicate: true };
    }
    return publicBrief(written, await currencyMap([...written.sourceRefs, ...written.learningRefs]), {});
  }

  async function readBrief(params) {
    const path = recordPath(params.path, BRIEF_PREFIX);
    const brief = await requireBrief(path);
    const sourceStatus = await currencyMap([...(brief.sourceRefs ?? []), ...(brief.learningRefs ?? [])]);
    return publicBrief(brief, sourceStatus, await reviewOutputCurrency(brief));
  }

  async function resolveOutputRefs(outputInput, brief) {
    const selfPath = brief.path;
    const sourceIds = new Set([...(brief.sourceRefs ?? []), ...(brief.learningRefs ?? [])].map(ref => ref.libraryId));
    const pinned = await helper.pinSources(outputInput);
    const result = [];
    for (const ref of pinned) {
      if (ref.path === selfPath) fail('不能把简报自身当作最终作品');
      if (sourceIds.has(ref.libraryId)) fail('不能把简报名义来源当作最终作品');
      const part = await library.handlers['library/read']({ id: ref.libraryId, version: ref.version, offset: 0 });
      if (!Number.isSafeInteger(part.size) || part.size <= 0) fail('引用的成果是空文件');
      if (part.sha256 !== ref.version) fail('成果版本校验失败', -32005);
      if (/\.(md|txt|html?|json|csv|tsv)$/i.test(ref.name) && part.size <= 2 * 1024 * 1024) {
        const content = await helper.readVersion(ref.libraryId, ref.version);
        if (!content.text.trim()) fail('引用的成果是空文件');
      }
      result.push({ libraryId: ref.libraryId, version: ref.version, path: ref.path, name: ref.name, size: part.size });
    }
    return result;
  }
  function buildEvaluations(evaluationsInput, criterionIds, outputInput) {
    const knownOutputs = new Set(outputInput.map(ref => ref.id));
    const seen = new Set();
    const evaluations = evaluationsInput.map(evaluation => {
      if (!criterionIds.has(evaluation.criterionId)) fail(`未知验收项 ${evaluation.criterionId}`);
      if (seen.has(evaluation.criterionId)) fail('同一验收项不能重复评审');
      seen.add(evaluation.criterionId);
      if (evaluation.outputId && !knownOutputs.has(evaluation.outputId)) fail(`outputId ${evaluation.outputId} 不在本次成果中`);
      return { criterionId: evaluation.criterionId, outcome: evaluation.outcome, note: evaluation.note, outputId: evaluation.outputId ?? null };
    });
    if (seen.size !== criterionIds.size) fail('evaluations 必须且只能覆盖每一项验收要求');
    return evaluations;
  }

  async function reviewBrief(params) {
    const path = recordPath(params.path, BRIEF_PREFIX);
    const reviewId = requireId(params.reviewId, 'reviewId');
    if (!['agent', 'user'].includes(params.reviewer)) fail('reviewer 必须是 agent 或 user（主观评审必须注明评审者）');
    const outputInput = normalizeRefs(params.outputRefs, 'outputRefs');
    const evaluationsInput = normalizeEvaluations(params.evaluations);
    const fingerprint = fingerprintOf({ kind: 'creative-brief-review', reviewId, reviewer: params.reviewer, outputRefs: outputInput, evaluations: evaluationsInput });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const brief = await requireBrief(path);
      const criterionIds = new Set((brief.criteria ?? []).map(criterion => criterion.id));
      const evaluations = buildEvaluations(evaluationsInput, criterionIds, outputInput);
      const existing = (brief.reviews ?? []).find(review => review.reviewId === reviewId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) fail('reviewId 已用于不同的评审内容', -32602);
        return { ...publicBrief(brief, await currencyMap([...(brief.sourceRefs ?? []), ...(brief.learningRefs ?? [])]), await reviewOutputCurrency(brief)), duplicate: true };
      }
      if ((brief.reviews ?? []).length >= MAX_REVIEWS) fail('评审记录已达 100 条，请创建新版简报；已有记录保留');
      const outputRefs = await resolveOutputRefs(outputInput, brief);
      const status = evaluations.every(evaluation => evaluation.outcome === 'pass') ? 'ready' : 'revision-needed';
      const review = { reviewId, at: nowIso(), reviewer: params.reviewer, outputRefs, evaluations, status, fingerprint };
      const next = { ...brief, status, reviews: [...(brief.reviews ?? []), review] };
      try {
        const written = await helper.write(path, next, brief.sha256);
        return publicBrief(written, await currencyMap([...(written.sourceRefs ?? []), ...(written.learningRefs ?? [])]), await reviewOutputCurrency(written));
      } catch (error) {
        if (error.rpc?.code !== -32005) throw error;
      }
    }
    fail('并发更新冲突，请重试', -32005);
  }

  const commands = {
    'creative/brief/create': createBrief,
    'creative/brief/read': readBrief,
    'creative/brief/review': reviewBrief,
  };

  const toolDescriptors = () => [
    {
      name: 'creative_brief', source: 'creative',
      description: 'Create, read or review a source-grounded creative brief stored in the personal library. create pins at least one source and verifies every claim line+quote against the actual source bytes; the brief records an explicit author and acceptance criteria. review appends a delivery evaluation that must cover every criterion and cite real, non-empty, pinned output artifacts — never the brief itself or its sources. Reads re-check source and output pins so outdated evidence is flagged instead of shown as current. Association with learning artifacts is not a mastery claim.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['create', 'read', 'review'] },
          requestId: { type: 'string', description: 'Stable idempotency key; same id + same payload returns the existing brief, different payload is rejected.' },
          title: { type: 'string' }, audience: { type: 'string' }, objective: { type: 'string' }, format: { type: 'string' },
          authorship: { type: 'string', enum: ['agent', 'user'] },
          path: { type: 'string', description: 'Brief path under creative/简报/ for read and review.' },
          sourceRefs: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'object', properties: { id: { type: 'string' }, version: { type: 'string' } }, required: ['id'], additionalProperties: false } },
          learningRefs: { type: 'array', maxItems: 20, items: { type: 'object', properties: { id: { type: 'string' }, version: { type: 'string' } }, required: ['id'], additionalProperties: false } },
          claims: { type: 'array', minItems: 1, maxItems: 200, items: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' }, evidence: { type: 'object', properties: { libraryId: { type: 'string' }, version: { type: 'string' }, line: { type: 'integer' }, quote: { type: 'string' } }, required: ['libraryId', 'line', 'quote'], additionalProperties: false } }, required: ['text', 'evidence'], additionalProperties: false } },
          criteria: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object', properties: { id: { type: 'string' }, description: { type: 'string' } }, required: ['id', 'description'], additionalProperties: false } },
          outline: { type: 'array', maxItems: 200, items: { type: 'object', properties: { title: { type: 'string' }, summary: { type: 'string' }, claimIds: { type: 'array', items: { type: 'string' } } }, required: ['title', 'summary'], additionalProperties: false } },
          reviewId: { type: 'string', description: 'Idempotency key for review; retried identical reviews are not appended twice.' },
          reviewer: { type: 'string', enum: ['agent', 'user'] },
          outputRefs: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'object', properties: { id: { type: 'string' }, version: { type: 'string' } }, required: ['id'], additionalProperties: false } },
          evaluations: { type: 'array', minItems: 1, maxItems: 200, items: { type: 'object', properties: { criterionId: { type: 'string' }, outcome: { type: 'string', enum: ['pass', 'needs-work', 'not-checked'] }, note: { type: 'string' }, outputId: { type: 'string' } }, required: ['criterionId', 'outcome', 'note'], additionalProperties: false } },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
  ];

  async function callTool(name, params = {}) {
    if (name !== 'creative_brief') return undefined;
    const handler = commands[`creative/brief/${params.action}`];
    if (!handler) fail('creative_brief 需要 action: create、read 或 review');
    return handler(params);
  }

  return { commands, toolDescriptors, callTool, root: 'creative' };
}

module.exports = { createCreativeBrief };
