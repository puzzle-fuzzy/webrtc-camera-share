import { ArrowUpRightIcon, CameraIcon, PlayIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { buttonVariants } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { GITHUB_URL, PageShell } from "@/features/page-shell"
import { cn } from "@/lib/utils"

export function AboutPage() {
  return (
    <PageShell currentPage="about">
      <section className="editorial-hero" aria-labelledby="about-title">
        <div className="editorial-hero-kicker">
          <span>03 / ABOUT</span>
          <span>OPEN SOURCE / PRIVACY FIRST</span>
        </div>
        <div className="editorial-hero-grid">
          <div>
            <p className="editorial-section-label">CAMERA SHARE / PROJECT NOTE</p>
            <h1 id="about-title" className="editorial-title">
              不只是
              <br />
              <span>一张画面</span>
            </h1>
            <p className="editorial-deck">
              Camera Share 是一个轻量、安全的一发多收摄像头共享工具，为临时协作而生。
            </p>
          </div>
          <aside className="editorial-hero-note editorial-hero-note-blue" aria-label="项目摘要">
            <span className="editorial-note-number">03</span>
            <strong>开源项目</strong>
            <span>WEBRTC / AXUM</span>
            <span>NO VIDEO STORAGE</span>
          </aside>
        </div>
      </section>

      <Card className="editorial-card about-card ring-0">
        <CardHeader className="editorial-card-header">
          <div>
            <p className="editorial-section-label">SYSTEM / PRINCIPLES</p>
            <CardTitle className="editorial-card-title">连接发生在两端之间</CardTitle>
            <CardDescription className="editorial-card-description">
              后台只协助找到彼此，不成为视频的中转站。
            </CardDescription>
          </div>
          <CardAction>
            <Badge variant="outline" className="editorial-badge">MIT / OPEN</Badge>
          </CardAction>
        </CardHeader>
        <CardContent className="about-grid">
          <section className="about-feature" aria-labelledby="about-privacy">
            <span className="about-feature-number">01</span>
            <h2 id="about-privacy">点对点视频</h2>
            <p>发送端直接通过 WebRTC 向最多 8 个接收端共享视频，服务端不保存或中转摄像头画面。</p>
          </section>
          <section className="about-feature" aria-labelledby="about-stack">
            <span className="about-feature-number">02</span>
            <h2 id="about-stack">小而清晰的架构</h2>
            <p>后台使用 Rust、Axum 与 Tokio；前端使用 Vite、React、TypeScript 和 shadcn/ui。</p>
          </section>
          <section className="about-feature about-feature-wide" aria-labelledby="about-source">
            <span className="about-feature-number">03</span>
            <h2 id="about-source">把控制权留在你的手里</h2>
            <a
              className="about-source-link"
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
            >
              github.com/puzzle-fuzzy/webrtc-camera-share
              <ArrowUpRightIcon aria-hidden="true" />
            </a>
          </section>
        </CardContent>
        <CardFooter className="editorial-card-footer">
          <div className="editorial-primary-action">
            <a
              className={cn(buttonVariants({ size: "lg" }), "editorial-button editorial-button-primary")}
              href="/send"
            >
              <CameraIcon data-icon="inline-start" />
              打开发送端
            </a>
            <span className="editorial-action-caption">START A NEW ROOM</span>
          </div>
          <a
            className={cn(
              buttonVariants({ variant: "outline", size: "lg" }),
              "editorial-button editorial-button-outline",
            )}
            href="/recv"
          >
            <PlayIcon data-icon="inline-start" />
            打开接收端
          </a>
        </CardFooter>
      </Card>
    </PageShell>
  )
}
