const fallbackRtcConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun.services.mozilla.com" },
  ],
} satisfies RTCConfiguration

const FALLBACK_MAX_RECEIVERS = 8
export const MAX_PENDING_ICE_CANDIDATES = 128

export type RuntimeConfiguration = {
  rtcConfiguration: RTCConfiguration
  maxReceivers: number
}

export function loadRuntimeConfiguration(): Promise<RuntimeConfiguration> {
  return fetchRuntimeConfiguration()
}

async function fetchRuntimeConfiguration(): Promise<RuntimeConfiguration> {
  try {
    const response = await fetch("/config", {
      cache: "no-store",
      headers: { accept: "application/json" },
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
      !Number.isSafeInteger(maxReceivers) ||
      typeof maxReceivers !== "number" ||
      maxReceivers < 1
    ) {
      throw new Error("配置字段无效")
    }

    return {
      rtcConfiguration: { iceServers: iceServers as RTCIceServer[] },
      maxReceivers,
    }
  } catch (error) {
    console.warn("Failed to load runtime WebRTC configuration", error)
    return {
      rtcConfiguration: fallbackRtcConfiguration,
      maxReceivers: FALLBACK_MAX_RECEIVERS,
    }
  }
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
    return { type: "authenticated" }
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
