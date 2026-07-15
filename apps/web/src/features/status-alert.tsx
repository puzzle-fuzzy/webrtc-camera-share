import { RadioIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"

type StatusAlertProps = {
  destructive?: boolean
  message: string
}

export function StatusAlert({ destructive = false, message }: StatusAlertProps) {
  return (
    <Alert
      variant={destructive ? "destructive" : "default"}
      role="status"
      aria-live="polite"
    >
      <RadioIcon />
      <AlertTitle>连接状态</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  )
}
