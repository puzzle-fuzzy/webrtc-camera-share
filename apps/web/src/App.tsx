import { AboutPage } from "@/features/about/about-page"
import { ReceiverPage } from "@/features/receiver/receiver-page"
import { SenderPage } from "@/features/sender/sender-page"

function App() {
  const receiverPaths = new Set(["/recv", "/recv.html"])
  const aboutPaths = new Set(["/about", "/about.html"])

  if (receiverPaths.has(window.location.pathname)) {
    document.title = "接收端 · 摄像头共享"
    return <ReceiverPage />
  }
  if (aboutPaths.has(window.location.pathname)) {
    document.title = "关于 · 摄像头共享"
    return <AboutPage />
  }
  if (!["/", "/send", "/send.html"].includes(window.location.pathname)) {
    document.title = "页面不存在 · 摄像头共享"
    return (
      <main className="editorial-shell editorial-not-found">
        <div className="editorial-content">
          <p className="editorial-section-label">404 / NOT FOUND</p>
          <h1 className="editorial-title">页面不存在</h1>
          <p className="editorial-deck">这个地址没有对应的共享页面，请返回发送端或打开接收端链接。</p>
          <a className="editorial-not-found-link" href="/">返回发送端</a>
        </div>
      </main>
    )
  }
  document.title = "发送端 · 摄像头共享"
  return <SenderPage />
}

export default App
