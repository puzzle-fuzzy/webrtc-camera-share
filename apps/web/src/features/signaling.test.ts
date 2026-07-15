import { describe, expect, test } from "bun:test"

import { parseServerSignal } from "./signaling"

describe("signaling", () => {
  test("parses authentication and normalized signaling messages", () => {
    expect(parseServerSignal('{"type":"authenticated"}')).toEqual({
      type: "authenticated",
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
    expect(parseServerSignal(new Uint8Array())).toBeUndefined()
  })
})
