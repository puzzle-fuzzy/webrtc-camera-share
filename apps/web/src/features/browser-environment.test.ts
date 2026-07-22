import { describe, expect, test } from "bun:test"

import {
  receiverEnvironmentIssue,
  senderEnvironmentIssue,
  type BrowserEnvironment,
} from "./browser-environment"

const supportedEnvironment: BrowserEnvironment = {
  secureContext: true,
  hostname: "camera.example.com",
  hasWebSocket: true,
  hasPeerConnection: true,
  hasMediaDevices: true,
  hasGetUserMedia: true,
  hasCrypto: true,
}

describe("browser environment", () => {
  test("accepts a supported secure environment", () => {
    expect(senderEnvironmentIssue(supportedEnvironment)).toBeUndefined()
    expect(receiverEnvironmentIssue(supportedEnvironment)).toBeUndefined()
  })

  test("requires HTTPS for a remote sender", () => {
    expect(
      senderEnvironmentIssue({
        ...supportedEnvironment,
        secureContext: false,
      }),
    ).toEqual({
      tone: "error",
      message: "当前页面不是安全连接，请使用 HTTPS 后再访问摄像头",
    })
  })

  test("allows insecure loopback development", () => {
    for (const hostname of ["localhost", "127.0.0.1", "::1"]) {
      expect(
        senderEnvironmentIssue({
          ...supportedEnvironment,
          secureContext: false,
          hostname,
        }),
      ).toBeUndefined()
    }
  })

  test("reports sender camera and browser capability gaps", () => {
    expect(
      senderEnvironmentIssue({
        ...supportedEnvironment,
        hasGetUserMedia: false,
      })?.message,
    ).toBe("当前浏览器无法访问摄像头，请升级浏览器或更换设备")
    expect(
      senderEnvironmentIssue({
        ...supportedEnvironment,
        hasPeerConnection: false,
      })?.message,
    ).toBe("当前浏览器不支持 WebRTC，请升级浏览器后重试")
  })

  test("does not require camera access on the receiver", () => {
    expect(
      receiverEnvironmentIssue({
        ...supportedEnvironment,
        hasMediaDevices: false,
        hasGetUserMedia: false,
      }),
    ).toBeUndefined()
  })
})
