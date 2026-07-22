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
    <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-black ring-1 ring-foreground/10">
      <video
        ref={videoRef}
        aria-label={label}
        className={cn(
          "absolute inset-0 size-full bg-black object-contain transition-opacity motion-reduce:transition-none",
          hasMedia ? "opacity-100" : "pointer-events-none opacity-0",
          className,
        )}
        {...videoProps}
      />
      {!hasMedia && (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center text-sm text-muted-foreground"
          aria-hidden="true"
        >
          <VideoIcon className="size-5" />
          <p className="max-w-sm text-balance">{placeholder}</p>
        </div>
      )}
    </div>
  )
}
