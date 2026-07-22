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
import { Separator } from "@/components/ui/separator"
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
    <PageShell>
      <Card className="w-full">
        <CardHeader>
          <CardTitle>发送端</CardTitle>
          <CardDescription>共享当前设备的摄像头画面</CardDescription>
          <CardAction>
            <Badge variant="outline">{viewerLabel}</Badge>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <SessionFields
            session={session}
            disabled={sender.running}
            issue={issue}
            onChange={updateSession}
          />
          <Separator />
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
        </CardContent>
        <CardFooter className="grid grid-cols-1 gap-2 sm:flex sm:flex-wrap">
          {sender.running ? (
            <Button
              variant="destructive"
              size="lg"
              onClick={() => sender.stop()}
            >
              <SquareIcon data-icon="inline-start" />
              停止发送
            </Button>
          ) : (
            <Button size="lg" onClick={start}>
              <CameraIcon data-icon="inline-start" />
              开始发送
            </Button>
          )}
          <Button
            variant="secondary"
            size="lg"
            onClick={copyReceiverLink}
          >
            <CopyIcon data-icon="inline-start" />
            复制接收链接
          </Button>
          <Button
            variant="secondary"
            size="lg"
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
              )}
              href={shareUrl.href}
              target="_blank"
              rel="noreferrer"
            >
              打开接收端
              <ExternalLinkIcon data-icon="inline-end" />
            </a>
          ) : (
            <Button variant="outline" size="lg" disabled>
              打开接收端
              <ExternalLinkIcon data-icon="inline-end" />
            </Button>
          )}
        </CardFooter>
      </Card>
    </PageShell>
  )
}
