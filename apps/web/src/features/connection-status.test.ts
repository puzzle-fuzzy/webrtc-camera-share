import { describe, expect, test } from "bun:test"

import {
  connectionStateStatus,
  errorStatus,
  infoStatus,
  successStatus,
} from "./connection-status"

describe("connection status", () => {
  test("builds typed status messages", () => {
    expect(infoStatus("正在准备")).toEqual({
      message: "正在准备",
      tone: "info",
    })
    expect(successStatus("连接完成")).toEqual({
      message: "连接完成",
      tone: "success",
    })
    expect(errorStatus("连接失败")).toEqual({
      message: "连接失败",
      tone: "error",
    })
  })

  test("localizes every peer connection state", () => {
    expect(connectionStateStatus("new")).toEqual(
      infoStatus("等待视频连接..."),
    )
    expect(connectionStateStatus("connecting")).toEqual(
      infoStatus("正在建立视频连接..."),
    )
    expect(connectionStateStatus("connected")).toEqual(
      successStatus("视频连接已建立"),
    )
    expect(connectionStateStatus("disconnected")).toEqual(
      infoStatus("视频连接暂时中断，正在恢复..."),
    )
    expect(connectionStateStatus("failed")).toEqual(
      errorStatus("视频连接失败，请停止后重试"),
    )
    expect(connectionStateStatus("closed")).toEqual(
      infoStatus("视频连接已关闭"),
    )
  })
})
