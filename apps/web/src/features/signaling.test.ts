import { afterEach, describe, expect, test } from "bun:test"

import {
  loadRuntimeConfiguration,
  parseServerSignal,
  RuntimeConfigurationError,
} from "./signaling"

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

  test("allows the development fallback only when explicitly enabled", async () => {
    globalThis.fetch = ((_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          { once: true },
        )
      })) as typeof fetch

    const configuration = await loadRuntimeConfiguration(undefined, 1, {
      allowFallback: true,
    })

    expect(configuration.maxReceivers).toBe(8)
    expect(configuration.rtcConfiguration.iceServers).toHaveLength(3)
  })

  test("fails closed when production configuration is unavailable", async () => {
    globalThis.fetch = (() =>
      Promise.reject(new Error("network down"))) as unknown as typeof fetch

    await expect(
      loadRuntimeConfiguration(undefined, 1, { allowFallback: false }),
    ).rejects.toBeInstanceOf(RuntimeConfigurationError)
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

    await expect(
      loadRuntimeConfiguration(controller.signal, 1, { allowFallback: true }),
    ).rejects.toThrow()
  })
})
