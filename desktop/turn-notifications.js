'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { connectionError } = require('./connection-config');
const TERMINAL_CATEGORIES = ['completed', 'failed', 'cancelled', 'interrupted'];
const DEFAULT_PREFERENCES = { enabled: true, completed: true, failed: true, cancelled: false,
  interrupted: true, needsInput: true, sound: true, quietHours: false, quietStart: '23:00', quietEnd: '08:00', locale: 'zh' };
const METHODS = ['notifications/read', 'notifications/update'];
const TITLES = { completed: ['任务已完成', 'Task completed'], failed: ['任务失败', 'Task failed'],
  cancelled: ['任务已取消', 'Task cancelled'], interrupted: ['任务已停止', 'Task stopped'], needsInput: ['任务需要你确认', 'Your task needs attention'] };

function validatePreferences(input, previous = DEFAULT_PREFERENCES) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw connectionError(-32602, 'Invalid notification preferences');
  const next = { ...previous };
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(DEFAULT_PREFERENCES, key)) throw connectionError(-32602, 'Unknown notification preference');
    if (typeof DEFAULT_PREFERENCES[key] === 'boolean' ? typeof value !== 'boolean'
      : key === 'locale' ? !['zh', 'en'].includes(value) : typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
      throw connectionError(-32602, 'Invalid notification preference');
    }
    next[key] = value;
  }
  return next;
}

function isQuietTime(preferences, now = new Date()) {
  if (!preferences.quietHours) return false;
  const minutes = text => Number(text.slice(0, 2)) * 60 + Number(text.slice(3));
  const current = now.getHours() * 60 + now.getMinutes();
  const start = minutes(preferences.quietStart), end = minutes(preferences.quietEnd);
  return start === end || (start < end ? current >= start && current < end : current >= start || current < end);
}

function createTurnNotifier({ home, deliverability, onClick, Notification: injected, browser = false, now = () => new Date() } = {}) {
  const file = home ? path.join(home, 'data', 'user', 'settings', 'notifications.json') : null;
  let preferences = { ...DEFAULT_PREFERENCES };
  const seen = new Set();
  let storageError = false;
  let Notification = injected;
  if (!Notification && !browser) { try { Notification = require('electron').Notification; } catch {} }
  if (file) {
    try {
      const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (stored.version !== 1 || !Array.isArray(stored.seen)) throw new Error('Invalid notification store');
      preferences = validatePreferences(stored.preferences);
      for (const key of stored.seen.slice(-4096)) if (typeof key === 'string' && key.length < 600) seen.add(key);
    } catch (error) { storageError = error.code !== 'ENOENT'; }
  }
  function persist(next = preferences) {
    if (!file) return;
    if (storageError) throw connectionError(-32024, 'Notification settings could not be read; the original file is preserved');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = file + '.' + process.pid + '.tmp';
    try { fs.writeFileSync(temp, JSON.stringify({ version: 1, preferences: next, seen: [...seen] }), { mode: 0o600 }); fs.renameSync(temp, file); }
    finally { try { fs.unlinkSync(temp); } catch {} }
  }
  const read = () => ({ preferences: { ...preferences }, supported: Boolean(Notification?.isSupported?.()), persistent: Boolean(file), storageError });
  const update = params => {
    const next = validatePreferences(params, preferences);
    persist(next); preferences = next; return read();
  };
  return {
    handlers: { 'notifications/read': read, 'notifications/update': update },
    setPreferences(next) { try { validatePreferences(next, preferences); } catch { return; } return update(next); },
    getPreferences: () => ({ ...preferences }),
    reset() { seen.clear(); preferences = { ...DEFAULT_PREFERENCES }; persist(); },
    handle(notification) {
      const needsInput = ['approval/request', 'userInput/request'].includes(notification?.method);
      if (!needsInput && notification?.method !== 'turn/event') return false;
      const params = notification.params ?? {}, category = needsInput ? 'needsInput' : params.status;
      if (!needsInput && (params.kind !== undefined || !TERMINAL_CATEGORIES.includes(category))) return false;
      const { threadId, turnId } = params;
      if (typeof threadId !== 'string' || typeof turnId !== 'string' || !threadId || !turnId || threadId.length > 200 || turnId.length > 200) return false;
      const requestId = needsInput ? params.approvalId || params.itemId || params.requestId || params.id : undefined;
      if (needsInput && (typeof requestId !== 'string' || requestId.length > 200)) return false;
      const key = JSON.stringify([threadId, turnId, category, requestId]);
      if (seen.has(key)) return false;
      // Persist suppressed events too: reconnects must not replay old banners.
      seen.add(key); while (seen.size > 4096) seen.delete(seen.values().next().value);
      persist();
      if (!preferences.enabled || !preferences[category] || isQuietTime(preferences, now())
        || (deliverability && !deliverability()) || !Notification?.isSupported?.()) return false;
      const title = TITLES[category][preferences.locale === 'en' ? 1 : 0];
      const banner = new Notification({ title, body: preferences.locale === 'en' ? 'Open Knorvia to view the result.' : '打开 Knorvia 查看任务结果。', silent: !preferences.sound });
      banner.on('click', () => { try { onClick?.(threadId); } catch {} });
      banner.show(); return true;
    },
  };
}

module.exports = { DEFAULT_PREFERENCES, TERMINAL_CATEGORIES, METHODS, createTurnNotifier, validatePreferences, isQuietTime };
