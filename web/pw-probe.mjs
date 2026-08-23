import { chromium } from '@playwright/test'

const browser = await chromium.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--no-proxy-server'],
})
const page = await browser.newPage()
const pending = new Set()
page.on('request', r => pending.add(r.url()))
page.on('requestfinished', r => pending.delete(r.url()))
page.on('requestfailed', r => pending.delete(r.url()))
const started = Date.now()
try {
  await page.goto('http://localhost:3000/video-studio', { waitUntil: 'domcontentloaded', timeout: 20000 })
  console.log('DCL ok in', Date.now() - started, 'ms')
} catch (error) {
  console.log('DCL FAILED after', Date.now() - started, 'ms:', String(error).split('\n')[0])
}
await new Promise(resolve => setTimeout(resolve, 5000))
console.log('still pending:', [...pending].slice(0, 12))
console.log('readyState:', await page.evaluate(() => document.readyState))
console.log('has main:', await page.evaluate(() => Boolean(document.querySelector('main'))))
const response = await page.evaluate(async () => {
  const res = await fetch('/video-studio', { cache: 'no-store' })
  return `${res.status} ${res.headers.get('content-length') ?? 'no-length'} ${res.headers.get('transfer-encoding') ?? ''}`
})
console.log('in-page fetch:', response)
await browser.close()
