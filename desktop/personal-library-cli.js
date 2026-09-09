'use strict';
const path = require('node:path');
const { createPersonalLibrary } = require('./personal-library');
async function main() {
  const root = process.env.KNORVIA_LIBRARY_ROOT || path.resolve(__dirname, '../..');
  const library = createPersonalLibrary({ home: path.dirname(root) });
  const [command, ...args] = process.argv.slice(2);
  const methods = {
    list: () => library.handlers['library/list']({}),
    write: () => library.handlers['library/write']({ path: args[0], text: args[1], expectedSha256: args[2] }),
    put: () => library.put(path.resolve(args[0]), args[1], args[2]),
    move: () => library.handlers['library/move']({ from: args[0], to: args[1] }),
    trash: () => library.handlers['library/trash']({ path: args[0] }),
    restore: () => library.handlers['library/restore']({ id: args[0], path: args[1] }),
  };
  if (!methods[command]) throw new Error('Use: list | write <path> <text> [expected-sha256] | put <source> <path> [expected-sha256] | move <from> <to> | trash <path> | restore <id> [path]');
  process.stdout.write(JSON.stringify(await methods[command]()) + '\n');
}
if (require.main === module) main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
