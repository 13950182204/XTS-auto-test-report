import { useState } from 'react'
import { App } from './App.js'

export function Root(): ReactElement {
  const [key, setKey] = useState(0)
  return (
    <ErrorBoundary onReset={() => setKey((value) => value + 1)}>
      <App key={key} />
    </ErrorBoundary>
  )
}

import { Component, type ErrorInfo, type ReactElement } from 'react'

class ErrorBoundary extends Component<{ children: ReactElement; onReset: () => void }, { error: string | null }> {
  state = { error: null as string | null }

  static getDerivedStateFromError(error: unknown): { error: string } {
    return { error: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error) }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('[renderer] 未捕获异常：', error, info.componentStack)
  }

  render(): ReactElement {
    if (this.state.error) {
      return (
        <div className="error-host">
          <div className="panel">
            <div className="panel-head"><span className="panel-title">渲染进程出错</span></div>
            <pre className="status status--error">{this.state.error}</pre>
            <div className="actions"><button className="btn" onClick={() => this.props.onReset()}>重新加载界面</button></div>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
