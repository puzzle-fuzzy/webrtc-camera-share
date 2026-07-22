import {
  errorStatus,
  type ConnectionStatus,
} from "@/features/connection-status"

export type BrowserEnvironment = {
  secureContext: boolean
  hostname: string
  hasWebSocket: boolean
  hasPeerConnection: boolean
  hasMediaDevices: boolean
  hasGetUserMedia: boolean
  hasCrypto: boolean
}

export function currentBrowserEnvironment(): BrowserEnvironment {
  const mediaDevices = navigator.mediaDevices
  return {
    secureContext: window.isSecureContext,
    hostname: location.hostname,
    hasWebSocket: typeof WebSocket !== "undefined",
    hasPeerConnection: typeof RTCPeerConnection !== "undefined",
    hasMediaDevices: mediaDevices !== undefined,
    hasGetUserMedia: typeof mediaDevices?.getUserMedia === "function",
    hasCrypto: typeof globalThis.crypto?.getRandomValues === "function",
  }
}

export function senderEnvironmentIssue(
  environment: BrowserEnvironment,
): ConnectionStatus | undefined {
  if (
    !environment.secureContext &&
    !isLoopbackHostname(environment.hostname)
  ) {
    return errorStatus("当前页面不是安全连接，请使用 HTTPS 后再访问摄像头")
  }
  const sharedIssue = sharedEnvironmentIssue(environment)
  if (sharedIssue) return sharedIssue
  if (!environment.hasCrypto) {
    return errorStatus("当前浏览器无法安全生成房间凭据，请升级浏览器后重试")
  }
  if (!environment.hasMediaDevices || !environment.hasGetUserMedia) {
    return errorStatus("当前浏览器无法访问摄像头，请升级浏览器或更换设备")
  }
}

export function receiverEnvironmentIssue(
  environment: BrowserEnvironment,
): ConnectionStatus | undefined {
  return sharedEnvironmentIssue(environment)
}

function sharedEnvironmentIssue(
  environment: BrowserEnvironment,
): ConnectionStatus | undefined {
  if (!environment.hasWebSocket) {
    return errorStatus("当前浏览器不支持实时连接，请升级浏览器后重试")
  }
  if (!environment.hasPeerConnection) {
    return errorStatus("当前浏览器不支持 WebRTC，请升级浏览器后重试")
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
}
