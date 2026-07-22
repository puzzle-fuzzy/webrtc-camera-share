const fallbackRtcConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun.services.mozilla.com" },
  ],
} satisfies RTCConfiguration

const FALLBACK_MAX_RECEIVERS = 8
const RUNTIME_CONFIG_TIMEOUT_MS = 5_000
export const MAX_PENDING_ICE_CANDIDATES = 128

export function isRetryableSignalingClose(code: number): boolean {
  return ![
    1000,
    4000,
    4003,
    4008,
    4009,
    4010,
    4011,
    4012,
    4028,
    4029,
    4030,
  ].includes(code)
}

export class RuntimeConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RuntimeConfigurationError"
  }
}

export type RuntimeConfiguration = {
  rtcConfiguration: RTCConfiguration
  maxReceivers: number
}

export function loadRuntimeConfiguration(
  signal?: AbortSignal,
  timeoutMs = RUNTIME_CONFIG_TIMEOUT_MS,
  options: { allowFallback?: boolean } = {},
): Promise<RuntimeConfiguration> {
  return fetchRuntimeConfiguration(
    signal,
    timeoutMs,
    options.allowFallback ?? isLoopbackRuntime(),
  )
}

async function fetchRuntimeConfiguration(
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
  allowFallback: boolean,
): Promise<RuntimeConfiguration> {
  const controller = new AbortController()
  const abort = () => controller.abort(externalSignal?.reason)
  if (externalSignal?.aborted) abort()
  else externalSignal?.addEventListener("abort", abort, { once: true })
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch("/config", {
      cache: "no-store",
      headers: { accept: "application/json" },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`配置接口返回 ${response.status}`)

    const value: unknown = await response.json()
    if (!isRecord(value)) throw new Error("配置格式无效")

    const iceServers = Array.isArray(value.iceServers)
      ? value.iceServers.map(parseIceServer)
      : undefined
    const maxReceivers = value.maxReceivers
    if (
      !iceServers ||
      iceServers.some((server) => server === undefined) ||
      typeof maxReceivers !== "number" ||
      !Number.isSafeInteger(maxReceivers) ||
      maxReceivers < 1 ||
      maxReceivers > FALLBACK_MAX_RECEIVERS
    ) {
      throw new Error("配置字段无效")
    }

    return {
      rtcConfiguration: { iceServers: iceServers as RTCIceServer[] },
      maxReceivers,
    }
  } catch (error) {
    if (externalSignal?.aborted) throw error
    if (!allowFallback) {
      const message = error instanceof Error ? error.message : "未知错误"
      throw new RuntimeConfigurationError(`无法加载连接配置：${message}`)
    }
    return {
      rtcConfiguration: fallbackRtcConfiguration,
      maxReceivers: FALLBACK_MAX_RECEIVERS,
    }
  } finally {
    clearTimeout(timeout)
    externalSignal?.removeEventListener("abort", abort)
  }
}

function isLoopbackRuntime(): boolean {
  if (typeof window === "undefined") return false
  return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(
    window.location.hostname,
  )
}

function parseIceServer(value: unknown): RTCIceServer | undefined {
  if (!isRecord(value)) return

  const urls = value.urls
  const validUrls =
    typeof urls === "string"
      ? urls.length > 0
      : Array.isArray(urls) &&
        urls.length > 0 &&
        urls.every((url) => typeof url === "string" && url.length > 0)
  if (!validUrls) return
  if (value.username !== undefined && typeof value.username !== "string") return
  if (value.credential !== undefined && typeof value.credential !== "string") return

  return {
    urls: urls as string | string[],
    ...(typeof value.username === "string" ? { username: value.username } : {}),
    ...(typeof value.credential === "string"
      ? { credential: value.credential }
      : {}),
  }
}

type SdpSignal = {
  type?: never
  peerId?: string
  sdp: RTCSessionDescriptionInit & { type: "offer" | "answer"; sdp: string }
}

type IceSignal = {
  type?: never
  peerId?: string
  ice: RTCIceCandidateInit & { candidate: string }
}

type ReceiverReadySignal = {
  type: "receiver-ready"
  peerId: string
}

type AuthenticatedSignal = {
  type: "authenticated"
  iceServers: RTCIceServer[]
  maxReceivers: number
}

type PeerLeftSignal =
  | { type: "peer-left"; role: "send"; peerId?: never }
  | { type: "peer-left"; role: "recv"; peerId: string }

type ErrorSignal = {
  type: "error"
  code: string
  message: string
  peerId?: string
}

export type ServerSignal =
  | SdpSignal
  | IceSignal
  | AuthenticatedSignal
  | ReceiverReadySignal
  | PeerLeftSignal
  | ErrorSignal

export function parseServerSignal(message: unknown): ServerSignal | undefined {
  if (typeof message !== "string") return

  let value: unknown
  try {
    value = JSON.parse(message)
  } catch {
    return
  }
  if (!isRecord(value)) return

  if (isRecord(value.sdp)) {
    const type = value.sdp.type
    const sdp = value.sdp.sdp
    if ((type === "offer" || type === "answer") && typeof sdp === "string") {
      return {
        ...(typeof value.peerId === "string" ? { peerId: value.peerId } : {}),
        sdp: { type, sdp },
      }
    }
  }

  if (isRecord(value.ice) && typeof value.ice.candidate === "string") {
    const ice: IceSignal["ice"] = { candidate: value.ice.candidate }
    if (typeof value.ice.sdpMid === "string" || value.ice.sdpMid === null) {
      ice.sdpMid = value.ice.sdpMid
    }
    if (
      typeof value.ice.sdpMLineIndex === "number" ||
      value.ice.sdpMLineIndex === null
    ) {
      ice.sdpMLineIndex = value.ice.sdpMLineIndex
    }
    if (
      typeof value.ice.usernameFragment === "string" ||
      value.ice.usernameFragment === null
    ) {
      ice.usernameFragment = value.ice.usernameFragment
    }
    return {
      ...(typeof value.peerId === "string" ? { peerId: value.peerId } : {}),
      ice,
    }
  }

  if (value.type === "receiver-ready" && typeof value.peerId === "string") {
    return { type: "receiver-ready", peerId: value.peerId }
  }
  if (value.type === "authenticated") {
    const iceServers = parseIceServers(value.iceServers)
    if (
      !iceServers ||
      typeof value.maxReceivers !== "number" ||
      !Number.isSafeInteger(value.maxReceivers) ||
      value.maxReceivers < 1 ||
      value.maxReceivers > FALLBACK_MAX_RECEIVERS
    ) {
      return
    }
    return {
      type: "authenticated",
      iceServers,
      maxReceivers: value.maxReceivers,
    }
  }
  if (value.type === "peer-left" && value.role === "send") {
    return { type: "peer-left", role: "send" }
  }
  if (
    value.type === "peer-left" &&
    value.role === "recv" &&
    typeof value.peerId === "string"
  ) {
    return { type: "peer-left", role: "recv", peerId: value.peerId }
  }
  if (
    value.type === "error" &&
    typeof value.code === "string" &&
    typeof value.message === "string"
  ) {
    return {
      type: "error",
      code: value.code,
      message: value.message,
      ...(typeof value.peerId === "string" ? { peerId: value.peerId } : {}),
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseIceServers(value: unknown): RTCIceServer[] | undefined {
  if (!Array.isArray(value)) return
  const iceServers = value.map(parseIceServer)
  if (iceServers.some((server) => server === undefined)) return
  return iceServers as RTCIceServer[]
}
