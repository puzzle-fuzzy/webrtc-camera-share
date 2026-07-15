export const rtcConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun.services.mozilla.com" },
  ],
} satisfies RTCConfiguration

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
