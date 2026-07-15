import { afterEach, describe, expect, test } from "bun:test"

import { loadRuntimeConfiguration, parseServerSignal } from "./signaling"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("signaling", () => {
  test("parses authentication and normalized signaling messages", () => {
    expect(
      parseServerSignal(
        '{"type":"authenticated","iceServers":[{"urls":"stun:example.com"}],"maxReceivers":8}',
      ),
    ).toEqual({
      type: "authenticated",
      iceServers: [{ urls: "stun:example.com" }],
      maxReceivers: 8,
    })
    expect(
      parseServerSignal(
        '{"peerId":"peer-1","ice":{"candidate":"candidate:1","unknown":true}}',
      ),
    ).toEqual({
      peerId: "peer-1",
      ice: { candidate: "candidate:1" },
    })
  })

  test("ignores malformed and unknown messages", () => {
    expect(parseServerSignal("not-json")).toBeUndefined()
    expect(parseServerSignal('{"type":"unknown"}')).toBeUndefined()
    expect(
      parseServerSignal(
        '{"type":"authenticated","iceServers":[],"maxReceivers":9}',
      ),
    ).toBeUndefined()
    expect(parseServerSignal(new Uint8Array())).toBeUndefined()
  })

  test("falls back when runtime configuration times out", async () => {
    globalThis.fetch = ((_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          { once: true },
        )
      })) as typeof fetch

    const configuration = await loadRuntimeConfiguration(undefined, 1)

    expect(configuration.maxReceivers).toBe(8)
    expect(configuration.rtcConfiguration.iceServers).toHaveLength(3)
  })

  test("honors a caller cancellation", async () => {
    globalThis.fetch = ((_input, init) =>
      new Promise((_resolve, reject) => {
        if (init?.signal?.aborted) reject(new Error("aborted"))
        else {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          )
        }
      })) as typeof fetch
    const controller = new AbortController()
    controller.abort()

    const configuration = await loadRuntimeConfiguration(controller.signal)

    expect(configuration.maxReceivers).toBe(8)
  })
})
