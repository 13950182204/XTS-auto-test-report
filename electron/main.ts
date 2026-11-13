import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startServer } from './server.js'

let window: BrowserWindow | null = null
// ESM 主进程没有 __dirname，用 import.meta.url 推导。
const MAIN_DIR = path.dirname(fileURLToPath(import.meta.url))

async function main(): Promise<void> {
  await app.whenReady()
  const rendererDir = path.join(MAIN_DIR, '../../dist/renderer')
  const { port, close } = await startServer(app.getPath('userData'), rendererDir, (line) => console.log(`[server] ${line}`))
  console.log(`[app] 本地服务端口：${port}`)
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
    },
  })
  window.setMenuBarVisibility(false)
  // 渲染进程经本地服务加载（ES module 走 http，避开 file:// 的 CORS 黑屏）。
  void window.loadURL(`http://127.0.0.1:${port}/renderer/?port=${port}`)
  window.webContents.on('console-message', (_event, level, message) => {
    console.log(`[renderer:${level}] ${message}`)
  })
  window.webContents.on('did-fail-load', (_event, code, description, url) => {
    console.error(`[renderer] 加载失败(${code}): ${description} ${url}`)
  })
  window.on('closed', () => { window = null })
  app.on('window-all-closed', () => {
    close()
    app.quit()
  })
}

void main()
