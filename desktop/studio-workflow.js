'use strict';
const crypto = require('node:crypto');
const fail = message => { const e = new Error(message); e.rpc = { code: -32602, message }; throw e; };
const forbidden = key => ['__proto__', 'constructor', 'prototype'].includes(key);
const ROLES = ['prompt', 'seconds', 'size', 'aspect', 'count', 'reference', 'firstFrame', 'lastFrame'];
function inspectWorkflow(input, bindings) {
  let graph = input;
  if (typeof graph === 'string') {
    if (Buffer.byteLength(graph) > 512 * 1024) fail('工作流最大支持 512 KB');
    try { graph = JSON.parse(graph); } catch { fail('无法解析工作流 JSON，请检查文件格式'); }
  }
  if (Array.isArray(graph?.nodes)) fail('这是 ComfyUI 画布文件。请在 ComfyUI 中选择“文件 → 导出工作流（API）”，再导入这里。');
  if (graph?.prompt && typeof graph.prompt === 'object' && !graph.prompt.class_type) graph = graph.prompt;
  if (!graph || typeof graph !== 'object' || Array.isArray(graph) || !Object.keys(graph).length || Object.keys(graph).length > 500) fail('请选择有效的 ComfyUI API 工作流（1–500 个节点）');
  if (Buffer.byteLength(JSON.stringify(graph)) > 512 * 1024) fail('工作流最大支持 512 KB');
  const fields = [], nodes = [];
  for (const [id, node] of Object.entries(graph)) {
    if (forbidden(id) || !node || typeof node !== 'object' || typeof node.class_type !== 'string' || !node.class_type || !node.inputs || typeof node.inputs !== 'object' || Array.isArray(node.inputs)) fail('工作流节点需要 class_type 和 inputs；普通画布文件请先导出为 API 格式');
    const title = typeof node._meta?.title === 'string' ? node._meta.title.slice(0, 120) : node.class_type;
    nodes.push({ id, type: node.class_type, title });
    for (const [key, value] of Object.entries(node.inputs)) {
      if (forbidden(key)) fail('工作流含有不允许的字段');
      if (Array.isArray(value)) {
        if (value.length !== 2 || typeof value[0] !== 'string' || !graph[value[0]] || !Number.isInteger(value[1]) || value[1] < 0) fail(`节点 ${id} 的 ${key} 连接无效`);
      } else if (['string', 'number', 'boolean'].includes(typeof value)) fields.push({ node: id, input: key, title, type: typeof value, value });
      else fail(`节点 ${id} 的 ${key} 不是有效的 API 输入`);
    }
  }
  if (bindings !== undefined) {
    if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) fail('输入映射应为对象');
    const used = new Set();
    for (const [role, b] of Object.entries(bindings)) {
      if (!ROLES.includes(role) || !b || typeof b.node !== 'string' || typeof b.input !== 'string') fail('未知的工作流输入映射');
      const field = fields.find(f => f.node === b.node && f.input === b.input);
      if (!field) fail(`${role} 必须映射到可编辑字段，不能替换节点连接`);
      if (field.type !== (['seconds', 'count'].includes(role) ? 'number' : 'string')) fail(`${role} 的字段类型不匹配`);
      const key = JSON.stringify([b.node, b.input]);
      if (used.has(key)) fail('不同输入不能绑定到同一个字段');
      used.add(key);
    }
  }
  return { workflow: graph, sha256: crypto.createHash('sha256').update(JSON.stringify(graph)).digest('hex'), fields, nodes };
}
async function checkDependencies(profile, request) {
  const report = inspectWorkflow(profile.custom?.workflow, profile.custom?.bindings);
  const issues = [], checked = [];
  for (const type of [...new Set(report.nodes.map(n => n.type))]) {
    const response = await request(profile, `object_info/${encodeURIComponent(type)}`);
    const definition = response[type];
    if (!definition) { issues.push(`缺少节点：${type}`); continue; }
    checked.push(type);
    for (const node of report.nodes.filter(n => n.type === type)) {
      const inputs = { ...definition.input?.required, ...definition.input?.optional };
      for (const [name, spec] of Object.entries(inputs)) {
        const value = report.workflow[node.id].inputs[name];
        if (Array.isArray(value)) continue;
        if (Object.hasOwn(definition.input?.required ?? {}, name) && value === undefined) issues.push(`${node.title} 缺少输入 ${name}`);
        if (Array.isArray(spec?.[0]) && value !== undefined && !spec[0].includes(value)) issues.push(`${node.title} 的 ${name} 不可用：${String(value).slice(0, 100)}`);
      }
    }
  }
  if (!profile.custom?.bindings?.prompt) issues.push('尚未选择提示词字段');
  if (profile.custom?.outputNode && !report.workflow[profile.custom.outputNode]) issues.push('输出节点不存在');
  return { reachable: true, checked: 'workflow', sha256: report.sha256, nodeCount: report.nodes.length, checkedTypes: checked.length, issues: issues.slice(0, 100) };
}
module.exports = { inspectWorkflow, checkDependencies };
