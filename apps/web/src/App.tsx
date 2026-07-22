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
  document.title = "发送端 · 摄像头共享"
  return <SenderPage />
}

export default App
