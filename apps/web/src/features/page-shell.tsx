import type { ReactNode } from "react"
import { GitForkIcon, InfoIcon } from "lucide-react"

import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export const GITHUB_URL =
  "https://github.com/puzzle-fuzzy/webrtc-camera-share"

type PageShellProps = {
  children: ReactNode
  currentPage?: "about"
}

export function PageShell({ children, currentPage }: PageShellProps) {
  return (
    <main className="mx-auto flex min-h-svh w-full max-w-3xl flex-col justify-center gap-3 p-4 md:p-6">
      {children}
      <nav
        aria-label="项目信息"
        className="grid grid-cols-2 gap-2 sm:flex sm:justify-center"
      >
        <a
          aria-current={currentPage === "about" ? "page" : undefined}
          className={cn(
            buttonVariants({
              variant: currentPage === "about" ? "secondary" : "ghost",
              size: "lg",
            }),
          )}
          href="/about"
        >
          <InfoIcon data-icon="inline-start" />
          About
        </a>
        <a
          className={cn(buttonVariants({ variant: "ghost", size: "lg" }))}
          href={GITHUB_URL}
          target="_blank"
          rel="noreferrer"
        >
          <GitForkIcon data-icon="inline-start" />
          GitHub
        </a>
      </nav>
    </main>
  )
}
