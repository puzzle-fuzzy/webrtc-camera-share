import { useEffect, useMemo, useState } from "react"
import { CameraIcon, PlayIcon, SquareIcon } from "lucide-react"

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
import { useReceiver } from "@/features/receiver/use-receiver"
import { SessionFields } from "@/features/session-fields"
import {
  persistSession,
  sessionFromHash,
  validateSession,
  type Session,
} from "@/features/session"
import { StatusAlert } from "@/features/status-alert"
import { VideoStage } from "@/features/video-stage"
import { cn } from "@/lib/utils"

function sessionFromLocation(): Session {
  const session = sessionFromHash(location.hash)
  return {
    room: session.room ?? "",
    key: session.key ?? "",
  }
}

export function ReceiverPage() {
  const [session, setSession] = useState(sessionFromLocation)
  const [attempted, setAttempted] = useState(false)
  const receiver = useReceiver()
  const validation = useMemo(
    () => validateSession(session.room, session.key),
    [session],
  )
  const issue = attempted && !validation.ok ? validation.issue : undefined

  useEffect(() => {
    const loadHash = () => {
      if (!receiver.running) {
        setSession(sessionFromLocation())
        setAttempted(false)
      }
    }
    window.addEventListener("hashchange", loadHash)
    return () => window.removeEventListener("hashchange", loadHash)
  }, [receiver.running])

  const updateSession = (nextSession: Session) => {
    setSession(nextSession)
    setAttempted(false)
  }

  const start = () => {
    setAttempted(true)
    if (!validation.ok) return
    setSession(validation.session)
    persistSession(validation.session)
    receiver.start(validation.session)
  }

  return (
    <PageShell currentPage="recv">
      <section className="editorial-hero" aria-labelledby="receiver-title">
        <div className="editorial-hero-kicker">
          <span>02 / RECEIVER</span>
          <span>REMOTE CAMERA TO THIS SCREEN</span>
        </div>
        <div className="editorial-hero-grid">
          <div>
            <p className="editorial-section-label">CAMERA SHARE / RECEIVE MODE</p>
            <h1 id="receiver-title" className="editorial-title">
              让另一端的
              <br />
              <span>画面到这里</span>
            </h1>
            <p className="editorial-deck">
              填入发送端提供的房间信息，建立一条只传视频的点对点连接。
            </p>
          </div>
          <aside className="editorial-hero-note" aria-label="接收端说明">
            <span className="editorial-note-number">02</span>
            <strong>接收画面</strong>
            <span>REMOTE CAMERA</span>
            <span>PLAYBACK / CONTROL</span>
          </aside>
        </div>
      </section>

      <Card className="editorial-card workspace-card ring-0">
        <CardHeader className="editorial-card-header">
          <div>
            <p className="editorial-section-label">SESSION / JOIN ROOM</p>
            <CardTitle className="editorial-card-title">进入一个共享房间</CardTitle>
            <CardDescription className="editorial-card-description">
              使用发送端生成的房间 ID 和访问码，等待对方开始共享。
            </CardDescription>
          </div>
          <CardAction>
            <Badge variant="outline" className="editorial-badge">
              {receiver.running ? "接收中" : "接收端"}
            </Badge>
          </CardAction>
        </CardHeader>
        <CardContent className="editorial-workspace-content">
          <section className="workspace-config" aria-labelledby="receiver-setup-title">
            <div className="workspace-index" aria-hidden="true">01</div>
            <div>
              <h2 id="receiver-setup-title" className="workspace-subtitle">连接信息</h2>
              <p className="workspace-hint">如果你通过完整链接打开，这些信息会自动填入。</p>
            </div>
            <SessionFields
              session={session}
              disabled={receiver.running}
              issue={issue}
              onChange={updateSession}
            />
            <div className="workspace-rule" />
            <p className="workspace-footnote">
              <span className="status-dot" aria-hidden="true" />
              {receiver.running ? "正在等待发送端" : "不会上传或保存摄像头画面"}
            </p>
          </section>
          <section className="workspace-preview" aria-labelledby="receiver-preview-title">
            <div className="workspace-preview-heading">
              <div>
                <p className="editorial-section-label">02 / PLAYBACK</p>
                <h2 id="receiver-preview-title" className="workspace-subtitle">远端摄像头</h2>
              </div>
              <span className="workspace-code">REMOTE / 16:9</span>
            </div>
            <VideoStage
              videoRef={receiver.videoRef}
              label="远端摄像头画面"
              hasMedia={receiver.hasMedia}
              placeholder={
                receiver.running
                  ? "正在等待发送端的视频画面..."
                  : "开始接收后，这里会显示发送端的画面"
              }
              autoPlay
              controls
              playsInline
            />
            <StatusAlert status={receiver.status} />
          </section>
        </CardContent>
        <CardFooter className="editorial-card-footer">
          <div className="editorial-primary-action">
            {receiver.running ? (
              <Button
                variant="destructive"
                size="lg"
                className="editorial-button editorial-button-danger"
                onClick={() => receiver.stop()}
              >
                <SquareIcon data-icon="inline-start" />
                停止接收
              </Button>
            ) : (
              <Button size="lg" className="editorial-button editorial-button-primary" onClick={start}>
                <PlayIcon data-icon="inline-start" />
                开始接收
              </Button>
            )}
            <span className="editorial-action-caption">{receiver.running ? "LISTENING / WAITING" : "READY / JOIN WHEN YOU ARE"}</span>
          </div>
          <a
            className={cn(
              buttonVariants({ variant: "outline", size: "lg" }),
              "editorial-button editorial-button-outline",
            )}
            href="/send"
          >
            <CameraIcon data-icon="inline-start" />
            返回发送端
          </a>
        </CardFooter>
      </Card>
    </PageShell>
  )
}
