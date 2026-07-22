export type StatusTone = "info" | "success" | "error"

export type ConnectionStatus = {
  message: string
  tone: StatusTone
}

export function infoStatus(message: string): ConnectionStatus {
  return { message, tone: "info" }
}

export function successStatus(message: string): ConnectionStatus {
  return { message, tone: "success" }
}

export function errorStatus(message: string): ConnectionStatus {
  return { message, tone: "error" }
}

export function connectionStateStatus(
  state: RTCPeerConnectionState,
): ConnectionStatus {
  switch (state) {
    case "new":
      return infoStatus("等待视频连接...")
    case "connecting":
      return infoStatus("正在建立视频连接...")
    case "connected":
      return successStatus("视频连接已建立")
    case "disconnected":
      return infoStatus("视频连接暂时中断，正在恢复...")
    case "failed":
      return errorStatus("视频连接失败，请停止后重试")
    case "closed":
      return infoStatus("视频连接已关闭")
  }
}
