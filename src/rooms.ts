import { createHash, timingSafeEqual } from "node:crypto";

import type { Role } from "./signaling.ts";

const roomIdPattern = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
const accessCodePattern = /^[A-Za-z0-9]{6,32}$/;

export const DEFAULT_MAX_RECEIVERS = 8;

type RoomState = {
  accessCodeHash: string;
  senderId?: string;
  receiverIds: Set<string>;
};

export type JoinRoomResult =
  | "joined"
  | "invalid-access-code"
  | "role-occupied"
  | "room-full";

export function normalizeRoomId(value: string | null): string | undefined {
  if (value === null) return;
  const normalized = value.trim().toLowerCase();
  return roomIdPattern.test(normalized) ? normalized : undefined;
}

export function isValidAccessCode(value: string | null): value is string {
  return value !== null && accessCodePattern.test(value);
}

export function hashAccessCode(accessCode: string): string {
  return createHash("sha256").update(accessCode).digest("hex");
}

function hashesMatch(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

export class RoomRegistry {
  readonly #rooms = new Map<string, RoomState>();

  constructor(readonly maxReceivers = DEFAULT_MAX_RECEIVERS) {}

  join(
    roomId: string,
    accessCodeHash: string,
    role: Role,
    peerId: string,
  ): JoinRoomResult {
    let room = this.#rooms.get(roomId);
    if (!room) {
      room = {
        accessCodeHash,
        receiverIds: new Set(),
      };
      this.#rooms.set(roomId, room);
    }

    if (!hashesMatch(room.accessCodeHash, accessCodeHash)) {
      return "invalid-access-code";
    }

    if (role === "send") {
      if (room.senderId) return "role-occupied";
      room.senderId = peerId;
      return "joined";
    }

    if (room.receiverIds.has(peerId)) return "role-occupied";
    if (room.receiverIds.size >= this.maxReceivers) return "room-full";
    room.receiverIds.add(peerId);
    return "joined";
  }

  leave(roomId: string, role: Role, peerId: string): void {
    const room = this.#rooms.get(roomId);
    if (!room) return;

    if (role === "send" && room.senderId === peerId) {
      room.senderId = undefined;
    } else if (role === "recv") {
      room.receiverIds.delete(peerId);
    }

    if (!room.senderId && room.receiverIds.size === 0) {
      this.#rooms.delete(roomId);
    }
  }

  hasReceiver(roomId: string, peerId: string): boolean {
    return this.#rooms.get(roomId)?.receiverIds.has(peerId) ?? false;
  }

  receiverIds(roomId: string): string[] {
    return [...(this.#rooms.get(roomId)?.receiverIds ?? [])];
  }

  get roomCount(): number {
    return this.#rooms.size;
  }

  get peerCount(): number {
    let count = 0;
    for (const room of this.#rooms.values()) {
      count += (room.senderId ? 1 : 0) + room.receiverIds.size;
    }
    return count;
  }
}
