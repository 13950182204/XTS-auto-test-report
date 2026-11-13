import { app, BrowserWindow } from 'electron'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { startServer } from './server.js'

let window: BrowserWindow | null = null

async function main(): Promise<void> {
  await app.whenReady()
  const { port, close } = await startServer(app.getPath('userData'), (line) => console.log(`[server] ${line}`))
  console.log(`[app] 渲染进程 API 端口：${port}`)
  window = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 1040,
    minHeight: 720,
    title: 'OpenHarmony XTS 报告上传',
    backgroundColor: '#141519',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  const rendererUrl = pathToFileURL(path.join(__dirname, '../../dist/renderer/index.html'))
  rendererUrl.searchParams.set('port', String(port))
  void window.loadURL(rendererUrl.toString())
  window.on('closed', () => { window = null })
  app.on('window-all-closed', () => {
    close()
    app.quit()
  })
}

void main()
