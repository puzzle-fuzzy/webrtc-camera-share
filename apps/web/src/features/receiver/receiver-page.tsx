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
import { Separator } from "@/components/ui/separator"
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
    <PageShell>
      <Card className="w-full">
        <CardHeader>
          <CardTitle>接收端</CardTitle>
          <CardDescription>播放发送端共享的远端摄像头画面</CardDescription>
          <CardAction>
            <Badge variant="outline">{receiver.running ? "接收中" : "接收端"}</Badge>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <SessionFields
            session={session}
            disabled={receiver.running}
            issue={issue}
            onChange={updateSession}
          />
          <Separator />
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
        </CardContent>
        <CardFooter className="grid grid-cols-1 gap-2 sm:flex sm:flex-wrap">
          {receiver.running ? (
            <Button
              variant="destructive"
              size="lg"
              onClick={() => receiver.stop()}
            >
              <SquareIcon data-icon="inline-start" />
              停止接收
            </Button>
          ) : (
            <Button size="lg" onClick={start}>
              <PlayIcon data-icon="inline-start" />
              开始接收
            </Button>
          )}
          <a
            className={cn(
              buttonVariants({ variant: "outline", size: "lg" }),
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
