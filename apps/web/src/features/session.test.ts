import { describe, expect, test } from "bun:test"

import { sessionFromHash, sessionHash, validateSession } from "./session"

describe("session", () => {
  test("normalizes valid values", () => {
    expect(validateSession(" Demo-Room ", " Demo2026 ")).toEqual({
      ok: true,
      session: { room: "demo-room", key: "Demo2026" },
    })
  })

  test("reports the first invalid field", () => {
    expect(validateSession("ab", "123456")).toEqual({
      ok: false,
      issue: {
        field: "room",
        message: "房间 ID 需为 3 到 32 位小写字母、数字或连字符",
      },
    })
    expect(validateSession("demo-room", "short")).toEqual({
      ok: false,
      issue: {
        field: "key",
        message: "访问码需为 6 到 32 位字母或数字",
      },
    })
  })

  test("round trips the URL fragment", () => {
    const session = { room: "demo-room", key: "123456" }
    expect(sessionFromHash(`#${sessionHash(session)}`)).toEqual(session)
  })
})
