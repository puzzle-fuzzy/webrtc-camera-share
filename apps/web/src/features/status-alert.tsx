import { RadioIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import type { ConnectionStatus } from "@/features/connection-status"

type StatusAlertProps = {
  status: ConnectionStatus
}

export function StatusAlert({ status }: StatusAlertProps) {
  const destructive = status.tone === "error"
  return (
    <Alert
      variant={destructive ? "destructive" : "default"}
      role={destructive ? "alert" : "status"}
      aria-live={destructive ? undefined : "polite"}
    >
      <RadioIcon />
      <AlertTitle>连接状态</AlertTitle>
      <AlertDescription>{status.message}</AlertDescription>
    </Alert>
  )
}
