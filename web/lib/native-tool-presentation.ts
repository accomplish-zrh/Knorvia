import type { Item } from './native-workbench-state';

export type ToolCategory = 'terminal' | 'read' | 'edit' | 'search' | 'browser' | 'image' | 'video' | 'agent' | 'library' | 'automation' | 'goal' | 'document' | 'spreadsheet' | 'presentation' | 'usage' | 'reasoning' | 'folder' | 'tool';
export type ToolState = 'running' | 'done' | 'failed' | 'stopped' | 'waiting' | undefined;
const captions: Record<ToolCategory, [string, string]> = {
  video: ['创作视频', 'Create video'], terminal: ['运行命令', 'Run command'], read: ['读取文件', 'Read file'], edit: ['修改文件', 'Edit file'], search: ['搜索', 'Search'], browser: ['浏览网页', 'Browse page'], image: ['处理图片', 'Work with images'], agent: ['协作任务', 'Agent collaboration'], library: ['操作资料库', 'Personal library'], automation: ['管理自动化', 'Manage automations'], goal: ['更新目标', 'Update goal'], document: ['处理文档', 'Work with documents'], spreadsheet: ['处理表格', 'Work with spreadsheets'], presentation: ['处理演示文稿', 'Work with presentations'], usage: ['本轮用量', 'Run usage'], reasoning: ['工作思路', 'Approach'], folder: ['查看目录', 'Browse files'], tool: ['调用工具', 'Use tool'],
};

export function toolPresentation(item: Pick<Item, 'kind' | 'status' | 'payload'>) {
  const p = item.payload;
  const identity = [p.server, p.namespace, p.tool, p.toolName, p.name].filter((value): value is string => typeof value === 'string' && Boolean(value.trim())).join(' · ');
  const kind = item.kind.replace(/[_.:-]/g, '').toLowerCase();
  const name = identity.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
  let category: ToolCategory = 'tool';
  if (kind === 'commandexecution') {
    const actions = Array.isArray(p.commandActions) ? p.commandActions : [];
    const types = actions.map(action => typeof action === 'object' && action ? String((action as Record<string, unknown>).type).toLowerCase() : '');
    // Parsed command actions are supplied by the Kernel, never guessed from shell text.
    category = types.length && types.every(type => type === 'read') ? 'read' : types.length && types.every(type => type === 'search') ? 'search' : types.length && types.every(type => type === 'listfiles') ? 'folder' : 'terminal';
  } else if (kind === 'filechange') category = 'edit';
  else if (kind === 'reasoning') category = 'reasoning';
  else if (kind === 'tokenusage') category = 'usage';
  else if (kind.includes('websearch')) category = 'search';
  else if (kind.includes('image')) category = 'image';
  else if (kind === 'subagent' || kind.includes('collab') || /spawn_agent|send_message_to_agent|wait_agent/.test(name)) category = 'agent';
  else if (kind === 'plan' || /(?:create|update|get)_goal/.test(name)) category = 'goal';
  else if (/library|资料库/.test(name)) category = 'library';
  else if (/automation|schedule|定时/.test(name)) category = 'automation';
  else if (/spreadsheet|excel|xlsx/.test(name)) category = 'spreadsheet';
  else if (/presentation|slide|pptx/.test(name)) category = 'presentation';
  else if (/videogen|video|media_edit|media_retake|media_subtitles/.test(name)) category = 'video';
  else if (/image|screenshot|photo/.test(name)) category = 'image';
  else if (/browser|chrome|navigate|playwright/.test(name)) category = 'browser';
  else if (/search|find|lookup/.test(name)) category = 'search';
  else if (/document|pdf|docx/.test(name)) category = 'document';
  else if (/exec_command|terminal|shell|write_stdin/.test(name)) category = 'terminal';
  else if (/apply_patch|write_file|edit_file|delete_file|move_file/.test(name)) category = 'edit';
  else if (/read_file|read_resource/.test(name)) category = 'read';
  else if (/list_files|list_directory/.test(name)) category = 'folder';
  const status = String(p.status ?? item.status).replace(/[_. -]/g, '').toLowerCase();
  let state: ToolState;
  if (p.success === false || p.isError === true || p.error || typeof p.exitCode === 'number' && p.exitCode !== 0 || ['failed', 'error', 'declined'].includes(status)) state = 'failed';
  else if (['cancelled', 'canceled', 'interrupted', 'stopped'].includes(status)) state = 'stopped';
  else if (['waiting', 'waitinginput', 'waitingapproval', 'pendingapproval'].includes(status)) state = 'waiting';
  else if (['running', 'inprogress', 'started', 'pending'].includes(status)) state = 'running';
  else if (['completed', 'succeeded', 'success', 'done'].includes(status)) state = 'done';
  return { category, zh: captions[category][0], en: captions[category][1], identity, state };
}
