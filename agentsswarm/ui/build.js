import { copyFile, mkdir } from 'node:fs/promises'

const dist = new URL('./dist/', import.meta.url)
await mkdir(new URL('dashboard/assets/', dist), { recursive: true })
await Promise.all([
  copyFile(new URL('./public/dashboard.html', import.meta.url), new URL('index.html', dist)),
  copyFile(new URL('./public/dashboard.html', import.meta.url), new URL('dashboard/index.html', dist)),
  copyFile(new URL('./public/monitor.css', import.meta.url), new URL('dashboard/assets/monitor.css', dist)),
  copyFile(new URL('./public/monitor.js', import.meta.url), new URL('dashboard/assets/monitor.js', dist)),
])
console.log('Built AgentSwarm Monitor in ui/dist')
