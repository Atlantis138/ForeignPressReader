import { Component, type ReactNode } from 'react'

export class AppErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    if (!this.state.failed) return this.props.children
    return (
      <main
        role="alert"
        style={{ padding: '2rem', maxWidth: '40rem', margin: 'auto' }}
      >
        <h1>页面暂时无法显示</h1>
        <p>已保存的阅读和学习数据仍保留在本机。请重新加载页面。</p>
        <button onClick={() => window.location.reload()}>重新加载</button>
      </main>
    )
  }
}
