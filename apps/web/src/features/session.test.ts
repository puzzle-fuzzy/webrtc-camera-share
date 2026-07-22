import { describe, expect, test } from "bun:test"

import {
  newSenderSession,
  randomSenderSession,
  sessionFromHash,
  sessionHash,
  socketUrl,
  validateSession,
} from "./session"

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

  test("keeps the access code out of the WebSocket URL", () => {
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: new URL("https://camera.example/send"),
    })
    const url = socketUrl("send", { room: "demo-room", key: "Secret123" })

    expect(url.toString()).toBe(
      "wss://camera.example/ws?role=send&room=demo-room",
    )
    expect(url.toString()).not.toContain("Secret123")
  })

  test("generates high-entropy defaults", () => {
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: new URL("https://camera.example/send"),
    })

    const session = randomSenderSession()

    expect(session.room).toMatch(/^demo-[a-f0-9]{24}$/)
    expect(session.key).toMatch(/^[a-f0-9]{32}$/)
  })

  test("rotates both sender credentials", () => {
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: new URL(
        "https://camera.example/send#room=demo-existing&key=Existing123",
      ),
    })

    const session = newSenderSession()

    expect(session.room).toMatch(/^demo-[a-f0-9]{24}$/)
    expect(session.key).toMatch(/^[a-f0-9]{32}$/)
    expect(session).not.toEqual({
      room: "demo-existing",
      key: "Existing123",
    })
  })
})
