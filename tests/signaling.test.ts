import { describe, expect, test } from "bun:test";

import { parseClientSignal } from "../src/signaling.ts";

const peerId = "12345678-1234-1234-1234-123456789abc";

describe("parseClientSignal", () => {
  test("accepts the expected SDP direction for each role", () => {
    expect(
      parseClientSignal(
        "send",
        JSON.stringify({ peerId, sdp: { type: "offer", sdp: "v=0" } }),
      ),
    ).toEqual({
      ok: true,
      signal: { peerId, sdp: { type: "offer", sdp: "v=0" } },
    });

    expect(
      parseClientSignal(
        "recv",
        JSON.stringify({ sdp: { type: "answer", sdp: "v=0" } }),
      ),
    ).toEqual({
      ok: true,
      signal: { sdp: { type: "answer", sdp: "v=0" } },
    });
  });

  test("rejects SDP sent by the wrong role", () => {
    const result = parseClientSignal(
      "send",
      JSON.stringify({ sdp: { type: "answer", sdp: "v=0" } }),
    );

    expect(result.ok).toBeFalse();
  });

  test("requires senders to target a server-issued peer ID", () => {
    expect(
      parseClientSignal(
        "send",
        JSON.stringify({ sdp: { type: "offer", sdp: "v=0" } }),
      ),
    ).toEqual({
      ok: false,
      message: "发送端信令缺少有效的 peerId",
    });

    expect(
      parseClientSignal(
        "send",
        JSON.stringify({ peerId, ice: { candidate: "candidate:1" } }),
      ),
    ).toEqual({
      ok: true,
      signal: { peerId, ice: { candidate: "candidate:1" } },
    });
  });

  test("normalizes ICE candidates and drops unknown fields", () => {
    expect(
      parseClientSignal(
        "recv",
        JSON.stringify({
          ice: {
            candidate: "candidate:1",
            sdpMid: "0",
            sdpMLineIndex: 0,
            unknown: "ignored",
          },
        }),
      ),
    ).toEqual({
      ok: true,
      signal: {
        ice: {
          candidate: "candidate:1",
          sdpMid: "0",
          sdpMLineIndex: 0,
        },
      },
    });
  });

  test("only lets the receiver request negotiation", () => {
    expect(
      parseClientSignal("recv", JSON.stringify({ type: "receiver-ready" })),
    ).toEqual({ ok: true, signal: { type: "receiver-ready" } });
    expect(
      parseClientSignal("send", JSON.stringify({ type: "receiver-ready" })).ok,
    ).toBeFalse();
  });

  test("rejects malformed and ambiguous messages", () => {
    expect(parseClientSignal("send", "not-json").ok).toBeFalse();
    expect(
      parseClientSignal(
        "send",
        JSON.stringify({
          sdp: { type: "offer", sdp: "v=0" },
          ice: { candidate: "candidate:1" },
        }),
      ).ok,
    ).toBeFalse();
  });
});
