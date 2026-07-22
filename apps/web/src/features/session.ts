export type Session = {
  room: string
  key: string
}

export type SessionIssue = {
  field: keyof Session
  message: string
}

export type SessionValidation =
  | { ok: true; session: Session }
  | { ok: false; issue: SessionIssue }

const roomPattern = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/
const accessCodePattern = /^[A-Za-z0-9]{6,32}$/

export function validateSession(roomValue: string, keyValue: string): SessionValidation {
  const room = roomValue.trim().toLowerCase()
  const key = keyValue.trim()

  if (!roomPattern.test(room)) {
    return {
      ok: false,
      issue: {
        field: "room",
        message: "房间 ID 需为 3 到 32 位小写字母、数字或连字符",
      },
    }
  }
  if (!accessCodePattern.test(key)) {
    return {
      ok: false,
      issue: {
        field: "key",
        message: "访问码需为 6 到 32 位字母或数字",
      },
    }
  }

  return { ok: true, session: { room, key } }
}

export function sessionFromHash(hash: string): Partial<Session> {
  const params = new URLSearchParams(hash.replace(/^#/, ""))
  return {
    room: params.get("room") ?? undefined,
    key: params.get("key") ?? undefined,
  }
}

export function sessionHash(session: Session): string {
  return new URLSearchParams(session).toString()
}

export function persistSession(session: Session): void {
  history.replaceState(
    null,
    "",
    `${location.pathname}${location.search}#${sessionHash(session)}`,
  )
}

export function receiverUrl(session: Session): URL {
  const url = new URL("/recv", location.href)
  url.hash = sessionHash(session)
  return url
}

export function socketUrl(role: "send" | "recv", session: Session): URL {
  const url = new URL("/ws", location.href)
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:"
  url.searchParams.set("role", role)
  url.searchParams.set("room", session.room)
  return url
}

export function randomSenderSession(): Session {
  const hash = sessionFromHash(location.hash)
  return {
    ...newSenderSession(),
    ...(hash.room ? { room: hash.room } : {}),
    ...(hash.key ? { key: hash.key } : {}),
  }
}

export function newSenderSession(): Session {
  return {
    room: `demo-${randomHex(12)}`,
    key: randomHex(16),
  }
}

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength)
  crypto.getRandomValues(bytes)
  return [...bytes]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")
}
