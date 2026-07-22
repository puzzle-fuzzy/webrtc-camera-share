import type { ReactNode } from "react"
import { ArrowUpRightIcon, InfoIcon } from "lucide-react"

import { cn } from "@/lib/utils"

export const GITHUB_URL =
  "https://github.com/puzzle-fuzzy/webrtc-camera-share"

type PageShellProps = {
  children: ReactNode
  currentPage?: "send" | "recv" | "about"
}

export function PageShell({ children, currentPage }: PageShellProps) {
  return (
    <main className="editorial-shell">
      <header className="editorial-masthead">
        <a className="editorial-brand" href="/send" aria-label="Camera Share 首页">
          CAMERA SHARE
        </a>
        <span className="editorial-masthead-meta">PRIVATE MEDIA / WEBRTC</span>
        <span className="editorial-masthead-count">MAX 8 VIEWERS</span>
      </header>
      <div className="editorial-content">{children}</div>
      <nav
        aria-label="项目信息"
        className="editorial-footer"
      >
        <a
          aria-current={currentPage === "about" ? "page" : undefined}
          className={cn("editorial-footer-link", currentPage === "about" && "is-active")}
          href="/about"
        >
          <InfoIcon aria-hidden="true" />
          <span>ABOUT / 关于</span>
        </a>
        <a
          className="editorial-footer-link"
          href={GITHUB_URL}
          target="_blank"
          rel="noreferrer"
        >
          <span>OPEN SOURCE / GitHub</span>
          <ArrowUpRightIcon aria-hidden="true" />
        </a>
      </nav>
    </main>
  )
}
