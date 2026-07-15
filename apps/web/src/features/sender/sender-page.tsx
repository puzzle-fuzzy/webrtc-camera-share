import { useMemo, useState } from "react"
import {
  CameraIcon,
  CopyIcon,
  ExternalLinkIcon,
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
import {
  persistSession,
  randomSenderSession,
  receiverUrl,
  validateSession,
} from "@/features/session"
import { StatusAlert } from "@/features/status-alert"
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
  const status = issue?.message ?? sender.status

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

  const copyReceiverLink = async () => {
    setAttempted(true)
    if (!validation.ok) return

    persistSession(validation.session)
    try {
      await navigator.clipboard.writeText(receiverUrl(validation.session).href)
      sender.setStatus("接收链接已复制")
    } catch {
      sender.setStatus("无法自动复制，请打开接收端后复制地址")
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
          <video
            ref={sender.previewRef}
            className="aspect-video w-full"
            autoPlay
            playsInline
            muted
            aria-label="本地摄像头预览"
          />
          <StatusAlert destructive={Boolean(issue)} message={status} />
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
            disabled={sender.running}
          >
            <CopyIcon data-icon="inline-start" />
            复制接收链接
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
