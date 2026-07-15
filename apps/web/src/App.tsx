import { ReceiverPage } from "@/features/receiver/receiver-page"
import { SenderPage } from "@/features/sender/sender-page"

function App() {
  const receiverPaths = new Set(["/recv", "/recv.html"])

  return receiverPaths.has(window.location.pathname) ? (
    <ReceiverPage />
  ) : (
    <SenderPage />
  )
}

export default App
