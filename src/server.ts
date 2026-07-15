import { randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  hashAccessCode,
  isValidAccessCode,
  normalizeRoomId,
  RoomRegistry,
} from "./rooms.ts";
import {
  parseClientSignal,
  roles,
  type Role,
  type ServerControlSignal,
} from "./signaling.ts";

type SocketData = {
  role: Role;
  peerId: string;
  roomId: string;
  accessCodeHash: string;
  accepted: boolean;
};

type Logger = Pick<Console, "info" | "warn" | "error">;

export type CreateServerOptions = {
  port?: number;
  hostname?: string;
  publicDir?: string;
  logger?: Logger;
};

const pageByPath = new Map([
  ["/", "send.html"],
  ["/send.html", "send.html"],
  ["/recv.html", "recv.html"],
]);

const pageHeaders = {
  "Cache-Control": "no-store",
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; media-src 'self' blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "Content-Type": "text/html; charset=utf-8",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

function isRole(value: string | null): value is Role {
  return roles.some((role) => role === value);
}

function serialize(signal: ServerControlSignal): string {
  return JSON.stringify(signal);
}

function senderTopic(roomId: string): string {
  return `room:${roomId}:send`;
}

function receiverTopic(roomId: string, peerId: string): string {
  return `room:${roomId}:recv:${peerId}`;
}

function receiversTopic(roomId: string): string {
  return `room:${roomId}:receivers`;
}

export function createServer(options: CreateServerOptions = {}) {
  const logger = options.logger ?? console;
  const publicDir = options.publicDir ?? join(import.meta.dir, "..", "public");
  const rooms = new RoomRegistry();

  let server: Bun.Server<SocketData>;
  server = Bun.serve<SocketData>({
    port: options.port ?? 5011,
    hostname: options.hostname ?? "0.0.0.0",
    async fetch(request, bunServer) {
      const url = new URL(request.url);

      if (url.pathname === "/ws") {
        const role = url.searchParams.get("role");
        const roomId = normalizeRoomId(url.searchParams.get("room"));
        const accessCode = url.searchParams.get("key");
        if (
          request.method !== "GET" ||
          !isRole(role) ||
          !roomId ||
          !isValidAccessCode(accessCode)
        ) {
          return new Response("Bad Request", { status: 400 });
        }

        const upgraded = bunServer.upgrade(request, {
          data: {
            role,
            peerId: randomUUID(),
            roomId,
            accessCodeHash: hashAccessCode(accessCode),
            accepted: false,
          },
        });
        return upgraded
          ? undefined
          : new Response("WebSocket upgrade failed", { status: 400 });
      }

      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { Allow: "GET, HEAD" },
        });
      }

      if (url.pathname === "/health") {
        return Response.json({
          ok: true,
          rooms: rooms.roomCount,
          peers: rooms.peerCount,
        });
      }

      const page = pageByPath.get(url.pathname);
      if (!page) return new Response("Not Found", { status: 404 });
      if (request.method === "HEAD") {
        return new Response(null, { headers: pageHeaders });
      }

      const file = Bun.file(join(publicDir, page));
      if (!(await file.exists())) {
        return new Response("Not Found", { status: 404 });
      }
      return new Response(file, { headers: pageHeaders });
    },
    websocket: {
      idleTimeout: 120,
      maxPayloadLength: 256 * 1024,
      open(ws) {
        const { role, peerId, roomId, accessCodeHash } = ws.data;
        const result = rooms.join(roomId, accessCodeHash, role, peerId);
        if (result === "invalid-access-code") {
          logger.warn(`[signal] rejected invalid access code for ${roomId}`);
          ws.close(4003, "invalid access code");
          return;
        }
        if (result === "role-occupied") {
          logger.warn(`[signal] rejected duplicate ${role} in ${roomId}`);
          ws.close(4009, "role occupied");
          return;
        }
        if (result === "room-full") {
          logger.warn(`[signal] rejected receiver because ${roomId} is full`);
          ws.close(4010, "room full");
          return;
        }

        ws.data.accepted = true;
        if (role === "send") {
          ws.subscribe(senderTopic(roomId));
        } else {
          ws.subscribe(receiverTopic(roomId, peerId));
          ws.subscribe(receiversTopic(roomId));
        }
        logger.info(`[signal] ${role} connected to ${roomId}`);

        if (role === "send") {
          for (const receiverId of rooms.receiverIds(roomId)) {
            ws.send(
              serialize({ type: "receiver-ready", peerId: receiverId }),
            );
          }
        }
      },
      message(ws, message) {
        if (!ws.data.accepted) return;

        const result = parseClientSignal(ws.data.role, message);
        if (!result.ok) {
          ws.send(
            serialize({
              type: "error",
              code: "INVALID_SIGNAL",
              message: result.message,
            }),
          );
          return;
        }

        const { role, peerId, roomId } = ws.data;
        if (role === "send") {
          if (!("peerId" in result.signal)) return;
          if (!rooms.hasReceiver(roomId, result.signal.peerId)) {
            ws.send(
              serialize({
                type: "error",
                code: "PEER_NOT_FOUND",
                message: "接收端已离线",
                peerId: result.signal.peerId,
              }),
            );
            return;
          }
          server.publish(
            receiverTopic(roomId, result.signal.peerId),
            JSON.stringify(result.signal),
          );
          return;
        }

        server.publish(
          senderTopic(roomId),
          JSON.stringify({ ...result.signal, peerId }),
        );
      },
      close(ws) {
        if (!ws.data.accepted) return;

        const { role, peerId, roomId } = ws.data;
        if (role === "send") {
          ws.unsubscribe(senderTopic(roomId));
          server.publish(
            receiversTopic(roomId),
            serialize({ type: "peer-left", role: "send" }),
          );
        } else {
          ws.unsubscribe(receiverTopic(roomId, peerId));
          ws.unsubscribe(receiversTopic(roomId));
          server.publish(
            senderTopic(roomId),
            serialize({ type: "peer-left", role: "recv", peerId }),
          );
        }
        rooms.leave(roomId, role, peerId);
        logger.info(`[signal] ${role} disconnected from ${roomId}`);
      },
    },
  });

  return server;
}
