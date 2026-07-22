import { useMemo, useState } from "react"
import {
  CameraIcon,
  CopyIcon,
  ExternalLinkIcon,
  RefreshCwIcon,
  SquareIcon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { PageShell } from "@/features/page-shell"
import { SessionFields } from "@/features/session-fields"
import { errorStatus, successStatus } from "@/features/connection-status"
import {
  newSenderSession,
  persistSession,
  randomSenderSession,
  receiverUrl,
  validateSession,
} from "@/features/session"
import { StatusAlert } from "@/features/status-alert"
import { VideoStage } from "@/features/video-stage"
import { useSender } from "@/features/sender/use-sender"
import { cn } from "@/lib/utils"

export function SenderPage() {
  const [session, setSession] = useState(randomSenderSession)
  const [attempted, setAttempted] = useState(false)
  const sender = useSender()
  const validation = useMemo(
    () => validateSession(session.room, session.key),
    [session],
  )
  const issue = attempted && !validation.ok ? validation.issue : undefined
  const shareUrl = validation.ok ? receiverUrl(validation.session) : undefined

  const updateSession = (nextSession: typeof session) => {
    setSession(nextSession)
    setAttempted(false)
  }

  const start = async () => {
    setAttempted(true)
    if (!validation.ok) return
    setSession(validation.session)
    persistSession(validation.session)
    await sender.start(validation.session)
  }

  const rotateSession = () => {
    setSession(newSenderSession())
    setAttempted(false)
    sender.setStatus(successStatus("已生成新的房间 ID 和访问码"))
  }

  const copyReceiverLink = async () => {
    setAttempted(true)
    if (!validation.ok) return

    persistSession(validation.session)
    try {
      await navigator.clipboard.writeText(receiverUrl(validation.session).href)
      sender.setStatus(successStatus("接收链接已复制，可以发送给接收者"))
    } catch {
      sender.setStatus(errorStatus("无法复制链接，请打开接收端后手动复制地址"))
    }
  }

  const viewerLabel = sender.running
    ? `${sender.viewers.connected}/${sender.viewers.total} 个已连接`
    : "发送端"

  return (
    <PageShell currentPage="send">
      <section className="editorial-hero" aria-labelledby="sender-title">
        <div className="editorial-hero-kicker">
          <span>01 / SENDER</span>
          <span>LOCAL CAMERA TO PRIVATE ROOM</span>
        </div>
        <div className="editorial-hero-grid">
          <div>
            <p className="editorial-section-label">CAMERA SHARE / LIVE SESSION</p>
            <h1 id="sender-title" className="editorial-title">
              把画面
              <br />
              <span>交给另一个人</span>
            </h1>
            <p className="editorial-deck">
              用一条临时链接分享当前摄像头。发送端直连接收端，后台只负责房间和信令。
            </p>
          </div>
          <aside className="editorial-hero-note" aria-label="发送端说明">
            <span className="editorial-note-number">01</span>
            <strong>发送画面</strong>
            <span>LOCAL CAMERA</span>
            <span>UP TO 8 VIEWERS</span>
          </aside>
        </div>
      </section>

      <Card className="editorial-card workspace-card ring-0">
        <CardHeader className="editorial-card-header">
          <div>
            <p className="editorial-section-label">SESSION / ROOM SETUP</p>
            <CardTitle className="editorial-card-title">建立一个共享房间</CardTitle>
            <CardDescription className="editorial-card-description">
              先确认房间信息，再打开摄像头并把接收链接发给对方。
            </CardDescription>
          </div>
          <CardAction>
            <Badge variant="outline" className="editorial-badge">
              {viewerLabel}
            </Badge>
          </CardAction>
        </CardHeader>
        <CardContent className="editorial-workspace-content">
          <section className="workspace-config" aria-labelledby="session-setup-title">
            <div className="workspace-index" aria-hidden="true">01</div>
            <div>
              <h2 id="session-setup-title" className="workspace-subtitle">房间信息</h2>
              <p className="workspace-hint">链接中会包含这两项信息，请只发给需要观看的人。</p>
            </div>
            <SessionFields
              session={session}
              disabled={sender.running}
              issue={issue}
              onChange={updateSession}
            />
            <div className="workspace-rule" />
            <p className="workspace-footnote">
              <span className="status-dot" aria-hidden="true" />
              {sender.running ? "房间正在接收连接" : "房间信息仅保存在当前浏览器"}
            </p>
          </section>
          <section className="workspace-preview" aria-labelledby="preview-title">
            <div className="workspace-preview-heading">
              <div>
                <p className="editorial-section-label">02 / PREVIEW</p>
                <h2 id="preview-title" className="workspace-subtitle">本地摄像头</h2>
              </div>
              <span className="workspace-code">LOCAL / 16:9</span>
            </div>
            <VideoStage
              videoRef={sender.previewRef}
              label="本地摄像头预览"
              hasMedia={sender.hasMedia}
              placeholder={
                sender.running
                  ? "正在准备摄像头画面..."
                  : "开始发送后，这里会显示摄像头预览"
              }
              autoPlay
              playsInline
              muted
            />
            <StatusAlert status={sender.status} />
          </section>
        </CardContent>
        <CardFooter className="editorial-card-footer">
          <div className="editorial-primary-action">
            {sender.running ? (
              <Button
                variant="destructive"
                size="lg"
                className="editorial-button editorial-button-danger"
                onClick={() => sender.stop()}
              >
                <SquareIcon data-icon="inline-start" />
                停止发送
              </Button>
            ) : (
              <Button size="lg" className="editorial-button editorial-button-primary" onClick={start}>
                <CameraIcon data-icon="inline-start" />
                开始发送
              </Button>
            )}
            <span className="editorial-action-caption">{sender.running ? "LIVE / SHARING" : "READY / START WHEN YOU ARE"}</span>
          </div>
          <div className="editorial-secondary-actions">
            <Button
              variant="secondary"
              size="lg"
              className="editorial-button editorial-button-secondary"
              onClick={copyReceiverLink}
            >
              <CopyIcon data-icon="inline-start" />
              复制接收链接
            </Button>
            <Button
              variant="secondary"
              size="lg"
              className="editorial-button editorial-button-secondary"
              onClick={rotateSession}
              disabled={sender.running}
            >
              <RefreshCwIcon data-icon="inline-start" />
              生成新会话
            </Button>
            {shareUrl ? (
              <a
                className={cn(
                  buttonVariants({ variant: "outline", size: "lg" }),
                  "editorial-button editorial-button-outline",
                )}
                href={shareUrl.href}
                target="_blank"
                rel="noreferrer"
              >
                打开接收端
                <ExternalLinkIcon data-icon="inline-end" />
              </a>
            ) : (
              <Button variant="outline" size="lg" className="editorial-button editorial-button-outline" disabled>
                打开接收端
                <ExternalLinkIcon data-icon="inline-end" />
              </Button>
            )}
          </div>
        </CardFooter>
      </Card>
    </PageShell>
  )
}
