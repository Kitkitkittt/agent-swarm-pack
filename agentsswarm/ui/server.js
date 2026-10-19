import { readFileSync } from 'node:fs'

const page = readFileSync(new URL('./public/dashboard.html', import.meta.url), 'utf8')
const assets = new Map([
  ['/dashboard/assets/monitor.css', {
    contentType: 'text/css; charset=utf-8',
    body: readFileSync(new URL('./public/monitor.css', import.meta.url), 'utf8'),
  }],
  ['/dashboard/assets/monitor.js', {
    contentType: 'text/javascript; charset=utf-8',
    body: readFileSync(new URL('./public/monitor.js', import.meta.url), 'utf8'),
  }],
])

export function renderDashboardPage() {
  return page
}

// Call with a normalized pathname, including when the bridge handles /api aliases.
export function readDashboardAsset(pathname) {
  return assets.get(pathname) || null
}
