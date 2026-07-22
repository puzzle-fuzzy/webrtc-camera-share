import type { ComponentProps, RefObject } from "react"
import { VideoIcon } from "lucide-react"

import { cn } from "@/lib/utils"

type VideoStageProps = Omit<ComponentProps<"video">, "aria-label" | "ref"> & {
  videoRef: RefObject<HTMLVideoElement | null>
  label: string
  hasMedia: boolean
  placeholder: string
}

export function VideoStage({
  videoRef,
  label,
  hasMedia,
  placeholder,
  className,
  ...videoProps
}: VideoStageProps) {
  return (
    <div className="video-stage">
      <div className="video-stage-meta" aria-hidden="true">
        <span>LIVE VIEW / 16:9</span>
        <span className={cn("video-stage-signal", hasMedia && "is-live")}>
          {hasMedia ? "SIGNAL LOCKED" : "NO SIGNAL"}
        </span>
      </div>
      <video
        ref={videoRef}
        aria-label={label}
        className={cn(
          "video-stage-media absolute inset-0 size-full bg-black object-contain transition-opacity motion-reduce:transition-none",
          hasMedia ? "opacity-100" : "pointer-events-none opacity-0",
          className,
        )}
        {...videoProps}
      />
      {!hasMedia && (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center text-sm text-muted-foreground"
          aria-live="polite"
        >
          <VideoIcon className="size-5" aria-hidden="true" />
          <p className="max-w-sm text-balance">{placeholder}</p>
        </div>
      )}
      <div className="video-stage-mark" aria-hidden="true">CAMERA / 01</div>
    </div>
  )
}
