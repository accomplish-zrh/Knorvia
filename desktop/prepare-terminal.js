'use strict';

// Compatibility fixes for the pinned node-pty 1.1.0 Windows JS glue. Keep the
// original native prebuilds intact. Revisit/remove when upgrading node-pty.
// Observed in real ConPTY tests: natural exit leaves the conout worker server
// alive; immediate close races the helper's AttachConsole and waits 5 seconds.
const fs = require('node:fs');
const path = require('node:path');
const root = path.dirname(require.resolve('node-pty/package.json'));
if (require('node-pty/package.json').version !== '1.1.0') throw new Error('Review terminal compatibility fixes before upgrading node-pty');
function patch(file, before, after) {
  const full = path.join(root, file); const text = fs.readFileSync(full, 'utf8').replaceAll('\r\n', '\n');
  if (text.includes(after)) return;
  if (!text.includes(before)) throw new Error(`Unexpected node-pty source in ${file}; review the terminal compatibility patch`);
  fs.writeFileSync(full, text.replace(before, after));
}
patch('lib/windowsPtyAgent.js',
  '        this._outSocket.destroy();\n    };',
  '        this._outSocket.destroy();\n        this._conoutSocketWorker.dispose(); // Knorvia: release the worker on natural exit.\n    };');
patch('lib/windowsPtyAgent.js',
  '        if (!this._useConptyDll) {\n            this._flushDataAndCleanUp();\n            this._outSocket.on(\'data\', function () { return _this._flushDataAndCleanUp(); });\n        }',
  '        this._flushDataAndCleanUp(); // Knorvia: both ConPTY backends must release readers.\n        this._outSocket.on(\'data\', function () { return _this._flushDataAndCleanUp(); });');
for (const method of ['_flushDataAndCleanUp', '_cleanUpProcess']) {
  const marker = `WindowsPtyAgent.prototype.${method} = function () {`;
  const file = path.join(root, 'lib/windowsPtyAgent.js');
  const text = fs.readFileSync(file, 'utf8');
  const start = text.indexOf(marker), end = text.indexOf('\n    };', start);
  if (start < 0 || end < 0) throw new Error('Unexpected node-pty cleanup implementation');
  const section = text.slice(start, end);
  const guard = '        if (this._useConptyDll) {\n            return;\n        }';
  if (section.includes(guard)) fs.writeFileSync(file, text.slice(0, start) + section.replace(guard, '        // Knorvia: finish draining either ConPTY backend.') + text.slice(end));
}
patch('lib/windowsPtyAgent.js',
  '            var timeout = setTimeout(function () {\n                // Something went wrong, just send back the shell PID',
  "            agent.once('exit', function () {\n                clearTimeout(timeout);\n                resolve([]); // Knorvia: the console may already have exited.\n            });\n            var timeout = setTimeout(function () {\n                // Something went wrong, just send back the shell PID");
patch('lib/conpty_console_list_agent.js',
  'var consoleProcessList = getConsoleProcessList(shellPid);',
  'var consoleProcessList;\ntry { consoleProcessList = getConsoleProcessList(shellPid); }\ncatch (_) { consoleProcessList = []; } // Knorvia: close can win the AttachConsole race.');
console.log('node-pty 1.1.0 terminal lifecycle compatibility fixes verified');
