import { CameraIcon, PlayIcon } from "lucide-react"

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
import { Separator } from "@/components/ui/separator"
import { GITHUB_URL, PageShell } from "@/features/page-shell"
import { cn } from "@/lib/utils"

export function AboutPage() {
  return (
    <PageShell currentPage="about">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>关于 Camera Share</CardTitle>
          <CardDescription>轻量、安全的一发多收摄像头共享工具</CardDescription>
          <CardAction>
            <Badge variant="outline">开源项目</Badge>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 text-sm text-muted-foreground">
          <p>
            发送端直接通过 WebRTC 向最多 8 个接收端共享视频。Rust
            后台只负责页面、房间状态和信令转发，不保存或中转摄像头画面。
          </p>
          <Separator />
          <section className="flex flex-col gap-2" aria-labelledby="about-stack">
            <h2 id="about-stack" className="font-medium text-foreground">
              技术架构
            </h2>
            <p>
              后台使用 Rust、Axum 与 Tokio；前端使用 Vite、React、TypeScript
              和 shadcn/ui，并固定使用原生黑色主题。
            </p>
          </section>
          <section className="flex flex-col gap-2" aria-labelledby="about-source">
            <h2 id="about-source" className="font-medium text-foreground">
              GitHub 地址
            </h2>
            <a
              className="break-all underline underline-offset-4 hover:text-foreground"
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
            >
              github.com/puzzle-fuzzy/webrtc-camera-share
            </a>
          </section>
        </CardContent>
        <CardFooter className="grid grid-cols-1 gap-2 sm:flex sm:flex-wrap">
          <a
            className={cn(buttonVariants({ size: "lg" }))}
            href="/send"
          >
            <CameraIcon data-icon="inline-start" />
            打开发送端
          </a>
          <a
            className={cn(
              buttonVariants({ variant: "secondary", size: "lg" }),
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
