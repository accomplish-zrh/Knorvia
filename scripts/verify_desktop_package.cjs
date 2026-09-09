'use strict';
// Verify the desktop whitelist before Electron Builder silently drops a module.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../desktop');
const config = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const included = new Set(config.build.files.filter(value => typeof value === 'string' && !value.includes('*')));
for (const entry of config.build.files.filter(value => typeof value === 'object')) {
  for (const name of entry.filter || []) if (!name.includes('*')) included.add(path.posix.join(entry.to, name));
}
const problems = [];
for (const file of included) {
  if (!file.endsWith('.js')) continue;
  const target = path.join(root, file);
  if (!fs.existsSync(target)) { problems.push(`Missing source: ${file}`); continue; }
  const source = fs.readFileSync(target, 'utf8');
  for (const match of source.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
    let dependency = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1]));
    if (!path.extname(dependency)) dependency += '.js';
    if (!included.has(dependency)) problems.push(`${file} requires unpackaged ${dependency}`);
  }
}
if (problems.length) { console.error(problems.join('\n')); process.exitCode = 1; }
else console.log(`Desktop dependency closure: ${included.size} entries verified.`);
