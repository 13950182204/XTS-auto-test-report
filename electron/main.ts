import { app, BrowserWindow, Menu, Tray, nativeImage } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startServer } from './server.js'

let window: BrowserWindow | null = null
let tray: Tray | null = null
// 关窗口只是藏窗口；只有托盘菜单「退出」和 app.quit() 才真的结束进程。
let quitting = false
// ESM 主进程没有 __dirname，用 import.meta.url 推导。
const MAIN_DIR = path.dirname(fileURLToPath(import.meta.url))
const ICON_DIR = path.join(MAIN_DIR, '../../build')

function showWindow(): void {
  if (!window) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

function createTray(): void {
  try {
    createTrayUnsafe()
  } catch (error) {
    // 托盘创建失败（缺图/系统限制）不能拖垮应用：窗口照常可用，只是没有常驻入口。
    console.error('[app] 托盘创建失败，关闭窗口将退出应用：', error)
    tray = null
  }
}

function createTrayUnsafe(): void {
  const icon = nativeImage.createFromPath(path.join(ICON_DIR, 'tray.png'))
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
  tray.setToolTip('OpenHarmony XTS 报告上传')
  const menu = Menu.buildFromTemplate([
    { label: '显示主界面', click: () => showWindow() },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        quitting = true
        app.quit()
      },
    },
  ])
  tray.setContextMenu(menu)
  tray.on('click', () => showWindow())
  tray.on('double-click', () => showWindow())
}

async function main(): Promise<void> {
  // 隐藏到托盘后用户常会再双击一次 exe：单实例化，第二次启动直接把已有窗口叫出来。
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }
  app.on('second-instance', () => showWindow())

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
    icon: path.join(ICON_DIR, 'icon.png'),
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

  createTray()

  // 点关闭按钮 = 收进托盘继续运行（用户要求 2026-11-26），不结束进程、不停本地服务。
  window.on('close', (event) => {
    // 没有托盘时不能藏窗口——否则用户再也找不回来，只能从任务管理器杀进程。
    if (quitting || !tray) return
    event.preventDefault()
    window?.hide()
    console.log('[app] 已最小化到托盘，测试/上传任务继续在后台执行')
  })
  window.on('closed', () => { window = null })

  // 窗口全关掉也不退出（Windows 默认会），真正的退出走托盘菜单或 app.quit()。
  app.on('window-all-closed', () => {
    if (!quitting) return
    close()
    app.quit()
  })
  app.on('before-quit', () => { quitting = true })
  app.on('will-quit', () => {
    close()
    tray?.destroy()
    tray = null
  })
}

void main()
