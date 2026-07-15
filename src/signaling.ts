export const roles = ["send", "recv"] as const;

export type Role = (typeof roles)[number];

export type SessionDescriptionSignal = {
  sdp: {
    type: "offer" | "answer";
    sdp: string;
  };
};

export type IceCandidateSignal = {
  ice: {
    candidate: string;
    sdpMid?: string | null;
    sdpMLineIndex?: number | null;
    usernameFragment?: string | null;
  };
};

export type ReceiverReadySignal = {
  type: "receiver-ready";
};

export type PeerSignal =
  | SessionDescriptionSignal
  | IceCandidateSignal;

export type RoutedSignal = (PeerSignal | ReceiverReadySignal) & {
  peerId: string;
};

export type ClientSignal = PeerSignal | ReceiverReadySignal | RoutedSignal;

export type ServerControlSignal =
  | (ReceiverReadySignal & { peerId: string })
  | { type: "peer-left"; role: "send" }
  | { type: "peer-left"; role: "recv"; peerId: string }
  | {
      type: "error";
      code: "INVALID_SIGNAL" | "PEER_NOT_FOUND";
      message: string;
      peerId?: string;
    };

export type ParseSignalResult =
  | { ok: true; signal: ClientSignal }
  | { ok: false; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPeerId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value)
  );
}

function parseIceCandidate(value: unknown): IceCandidateSignal | undefined {
  if (!isRecord(value) || typeof value.candidate !== "string") return;

  const candidate: IceCandidateSignal["ice"] = {
    candidate: value.candidate,
  };

  if (typeof value.sdpMid === "string" || value.sdpMid === null) {
    candidate.sdpMid = value.sdpMid;
  }
  if (typeof value.sdpMLineIndex === "number" || value.sdpMLineIndex === null) {
    candidate.sdpMLineIndex = value.sdpMLineIndex;
  }
  if (
    typeof value.usernameFragment === "string" ||
    value.usernameFragment === null
  ) {
    candidate.usernameFragment = value.usernameFragment;
  }

  return { ice: candidate };
}

export function parseClientSignal(
  role: Role,
  message: string | Uint8Array,
): ParseSignalResult {
  if (typeof message !== "string") {
    return { ok: false, message: "仅支持文本格式的 JSON 信令" };
  }

  let value: unknown;
  try {
    value = JSON.parse(message);
  } catch {
    return { ok: false, message: "信令不是有效的 JSON" };
  }

  if (!isRecord(value)) {
    return { ok: false, message: "信令必须是 JSON 对象" };
  }

  const signalKinds = ["sdp", "ice", "type"].filter((key) => key in value);
  if (signalKinds.length !== 1) {
    return { ok: false, message: "信令必须且只能包含一种消息类型" };
  }

  if ("sdp" in value) {
    if (!isRecord(value.sdp)) {
      return { ok: false, message: "SDP 信令格式无效" };
    }

    const expectedType = role === "send" ? "offer" : "answer";
    const peerId = role === "send" ? value.peerId : undefined;
    if (
      value.sdp.type !== expectedType ||
      typeof value.sdp.sdp !== "string" ||
      value.sdp.sdp.length === 0
    ) {
      return {
        ok: false,
        message: `${role} 角色只能发送有效的 ${expectedType} SDP`,
      };
    }
    if (role === "send" && !isPeerId(peerId)) {
      return { ok: false, message: "发送端信令缺少有效的 peerId" };
    }

    return {
      ok: true,
      signal: {
        ...(peerId ? { peerId } : {}),
        sdp: {
          type: expectedType,
          sdp: value.sdp.sdp,
        },
      },
    };
  }

  if ("ice" in value) {
    const signal = parseIceCandidate(value.ice);
    if (!signal) return { ok: false, message: "ICE candidate 格式无效" };

    const peerId = role === "send" ? value.peerId : undefined;
    if (role === "send" && !isPeerId(peerId)) {
      return { ok: false, message: "发送端信令缺少有效的 peerId" };
    }
    return {
      ok: true,
      signal: { ...(peerId ? { peerId } : {}), ...signal },
    };
  }

  if (role === "recv" && value.type === "receiver-ready") {
    return { ok: true, signal: { type: "receiver-ready" } };
  }

  return { ok: false, message: `${role} 角色不能发送该控制消息` };
}
