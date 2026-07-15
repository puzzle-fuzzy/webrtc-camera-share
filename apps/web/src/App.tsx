import { AboutPage } from "@/features/about/about-page"
import { ReceiverPage } from "@/features/receiver/receiver-page"
import { SenderPage } from "@/features/sender/sender-page"

function App() {
  const receiverPaths = new Set(["/recv", "/recv.html"])
  const aboutPaths = new Set(["/about", "/about.html"])

  if (receiverPaths.has(window.location.pathname)) return <ReceiverPage />
  if (aboutPaths.has(window.location.pathname)) return <AboutPage />
  return <SenderPage />
}

export default App
