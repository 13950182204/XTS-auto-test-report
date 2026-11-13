import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 渲染进程构建为静态文件，由 Electron 主进程 loadFile 加载（base 相对路径必须）。
export default defineConfig({
  plugins: [react()],
  base: '/renderer/',
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
  },
})
