import { cp, mkdir, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoot = path.join(webRoot, 'director-desk-src')
const distRoot = path.join(sourceRoot, 'dist')
const publicRoot = path.join(webRoot, 'public', 'director-desk')
const npmExecutable = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'npm'
const npmArguments = process.platform === 'win32' ? ['/d', '/s', '/c', 'npm run build'] : ['run', 'build']

await new Promise((resolve, reject) => {
  const child = spawn(npmExecutable, npmArguments, {
    cwd: sourceRoot,
    stdio: 'inherit',
  })
  child.on('error', reject)
  child.on('exit', code => code === 0 ? resolve() : reject(new Error(`白模预演构建失败，退出码 ${code}`)))
})

await rm(publicRoot, { recursive: true, force: true })
await mkdir(publicRoot, { recursive: true })
await cp(distRoot, publicRoot, { recursive: true, force: true })
console.log(`白模预演已发布到 ${publicRoot}`)
