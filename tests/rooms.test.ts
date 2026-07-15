import { describe, expect, test } from "bun:test";

import {
  hashAccessCode,
  isValidAccessCode,
  normalizeRoomId,
  RoomRegistry,
} from "../src/rooms.ts";

describe("room validation", () => {
  test("normalizes valid room IDs", () => {
    expect(normalizeRoomId("  Demo-Room  ")).toBe("demo-room");
    expect(normalizeRoomId("ab")).toBeUndefined();
    expect(normalizeRoomId("invalid_room")).toBeUndefined();
    expect(normalizeRoomId("-invalid-room")).toBeUndefined();
  });

  test("accepts only simple 6 to 32 character access codes", () => {
    expect(isValidAccessCode("123456")).toBeTrue();
    expect(isValidAccessCode("DemoCode2026")).toBeTrue();
    expect(isValidAccessCode("short")).toBeFalse();
    expect(isValidAccessCode("包含中文123")).toBeFalse();
  });
});

describe("RoomRegistry", () => {
  test("allows multiple receivers while keeping one sender per room", () => {
    const rooms = new RoomRegistry();
    const firstKey = hashAccessCode("123456");
    const secondKey = hashAccessCode("654321");

    expect(rooms.join("alpha-room", firstKey, "send", "sender-a")).toBe(
      "joined",
    );
    expect(rooms.join("alpha-room", firstKey, "recv", "receiver-a")).toBe(
      "joined",
    );
    expect(rooms.join("alpha-room", firstKey, "recv", "receiver-b")).toBe(
      "joined",
    );
    expect(rooms.join("alpha-room", firstKey, "send", "sender-b")).toBe(
      "role-occupied",
    );
    expect(
      rooms.join("alpha-room", secondKey, "recv", "receiver-c"),
    ).toBe("invalid-access-code");
    expect(rooms.join("beta-room", secondKey, "send", "sender-c")).toBe(
      "joined",
    );

    expect(rooms.roomCount).toBe(2);
    expect(rooms.peerCount).toBe(4);
    expect(rooms.receiverIds("alpha-room")).toEqual([
      "receiver-a",
      "receiver-b",
    ]);
    expect(rooms.hasReceiver("alpha-room", "receiver-b")).toBeTrue();

    rooms.leave("alpha-room", "send", "sender-a");
    rooms.leave("alpha-room", "recv", "receiver-a");
    rooms.leave("alpha-room", "recv", "receiver-b");
    expect(rooms.roomCount).toBe(1);
    expect(rooms.peerCount).toBe(1);
  });

  test("caps the number of receivers", () => {
    const rooms = new RoomRegistry(2);
    const key = hashAccessCode("123456");

    expect(rooms.join("demo-room", key, "recv", "receiver-a")).toBe(
      "joined",
    );
    expect(rooms.join("demo-room", key, "recv", "receiver-b")).toBe(
      "joined",
    );
    expect(rooms.join("demo-room", key, "recv", "receiver-c")).toBe(
      "room-full",
    );
  });
});
