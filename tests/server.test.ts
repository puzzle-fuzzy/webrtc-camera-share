import { afterEach, describe, expect, test } from "bun:test";

import { createServer } from "../src/server.ts";

const logger = {
  info() {},
  warn() {},
  error() {},
};

type TestServer = ReturnType<typeof createServer>;

type SocketClient = {
  socket: WebSocket;
  closed: Promise<CloseEvent>;
  nextMessage(): Promise<unknown>;
  pendingMessageCount(): number;
};

type Session = {
  room?: string;
  key?: string;
};

const servers: TestServer[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

function startServer(): TestServer {
  const server = createServer({
    port: 0,
    hostname: "127.0.0.1",
    logger,
  });
  servers.push(server);
  return server;
}

function connect(
  server: TestServer,
  role: "send" | "recv",
  session: Session = {},
): Promise<SocketClient> {
  return new Promise((resolve, reject) => {
    const url = new URL(`ws://127.0.0.1:${server.port}/ws`);
    url.searchParams.set("role", role);
    url.searchParams.set("room", session.room ?? "demo-room");
    url.searchParams.set("key", session.key ?? "123456");
    const socket = new WebSocket(url);
    const messages: string[] = [];
    const readers: Array<(message: string) => void> = [];
    const closed = new Promise<CloseEvent>((resolveClose) => {
      socket.addEventListener("close", resolveClose, { once: true });
    });

    socket.addEventListener("message", (event) => {
      const message = String(event.data);
      const reader = readers.shift();
      if (reader) reader(message);
      else messages.push(message);
    });
    socket.addEventListener("error", () => reject(new Error("WebSocket error")), {
      once: true,
    });
    socket.addEventListener(
      "open",
      () => {
        resolve({
          socket,
          closed,
          pendingMessageCount() {
            return messages.length;
          },
          nextMessage() {
            const queued = messages.shift();
            if (queued !== undefined) return Promise.resolve(JSON.parse(queued));

            return new Promise((resolveMessage, rejectMessage) => {
              const timeout = setTimeout(
                () => rejectMessage(new Error("Timed out waiting for message")),
                1_000,
              );
              readers.push((message) => {
                clearTimeout(timeout);
                resolveMessage(JSON.parse(message));
              });
            });
          },
        });
      },
      { once: true },
    );
  });
}

function getPeerId(message: unknown): string {
  if (
    typeof message !== "object" ||
    message === null ||
    !("peerId" in message) ||
    typeof message.peerId !== "string"
  ) {
    throw new Error("Expected a routed message with peerId");
  }
  expect(message.peerId).toMatch(
    /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i,
  );
  return message.peerId;
}

describe("HTTP server", () => {
  test("serves only known pages and exposes health", async () => {
    const server = startServer();
    const baseUrl = `http://127.0.0.1:${server.port}`;

    const page = await fetch(`${baseUrl}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await page.text()).toContain("发送端");

    expect((await fetch(`${baseUrl}/missing`)).status).toBe(404);
    expect(
      (await fetch(`${baseUrl}/send.html`, { method: "POST" })).status,
    ).toBe(405);
    expect(await (await fetch(`${baseUrl}/health`)).json()).toEqual({
      ok: true,
      rooms: 0,
      peers: 0,
    });
  });
});

describe("WebSocket signaling", () => {
  test("negotiates when the receiver connects first", async () => {
    const server = startServer();
    const receiver = await connect(server, "recv");
    receiver.socket.send(JSON.stringify({ type: "receiver-ready" }));

    const sender = await connect(server, "send");
    const receiverReady = await sender.nextMessage();
    const peerId = getPeerId(receiverReady);
    expect(receiverReady).toEqual({ type: "receiver-ready", peerId });

    const offer = { peerId, sdp: { type: "offer", sdp: "v=0" } };
    sender.socket.send(JSON.stringify(offer));
    expect(await receiver.nextMessage()).toEqual(offer);

    const answer = { sdp: { type: "answer", sdp: "v=0" } };
    receiver.socket.send(JSON.stringify(answer));
    expect(await sender.nextMessage()).toEqual({ ...answer, peerId });

    sender.socket.close();
    expect(await receiver.nextMessage()).toEqual({
      type: "peer-left",
      role: "send",
    });
    receiver.socket.close();
  });

  test("negotiates when the sender connects first", async () => {
    const server = startServer();
    const sender = await connect(server, "send");
    const receiver = await connect(server, "recv");

    receiver.socket.send(JSON.stringify({ type: "receiver-ready" }));
    const ready = await sender.nextMessage();
    expect(ready).toEqual({ type: "receiver-ready", peerId: getPeerId(ready) });

    sender.socket.close();
    receiver.socket.close();
  });

  test("rejects duplicate roles and invalid signaling", async () => {
    const server = startServer();
    const sender = await connect(server, "send");
    const duplicate = await connect(server, "send");

    expect((await duplicate.closed).code).toBe(4009);

    sender.socket.send(
      JSON.stringify({ sdp: { type: "answer", sdp: "v=0" } }),
    );
    expect(await sender.nextMessage()).toEqual({
      type: "error",
      code: "INVALID_SIGNAL",
      message: "send 角色只能发送有效的 offer SDP",
    });

    const missingPeerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    sender.socket.send(
      JSON.stringify({
        peerId: missingPeerId,
        sdp: { type: "offer", sdp: "v=0" },
      }),
    );
    expect(await sender.nextMessage()).toEqual({
      type: "error",
      code: "PEER_NOT_FOUND",
      message: "接收端已离线",
      peerId: missingPeerId,
    });

    sender.socket.close();
  });

  test("routes signaling independently to multiple receivers", async () => {
    const server = startServer();
    const sender = await connect(server, "send");
    const receiverA = await connect(server, "recv");
    const receiverB = await connect(server, "recv");

    receiverA.socket.send(JSON.stringify({ type: "receiver-ready" }));
    const peerA = getPeerId(await sender.nextMessage());
    receiverB.socket.send(JSON.stringify({ type: "receiver-ready" }));
    const peerB = getPeerId(await sender.nextMessage());
    expect(peerA).not.toBe(peerB);

    const offerA = { peerId: peerA, sdp: { type: "offer", sdp: "a" } };
    sender.socket.send(JSON.stringify(offerA));
    expect(await receiverA.nextMessage()).toEqual(offerA);
    await Bun.sleep(10);
    expect(receiverB.pendingMessageCount()).toBe(0);

    const answerA = { sdp: { type: "answer", sdp: "answer-a" } };
    receiverA.socket.send(JSON.stringify(answerA));
    expect(await sender.nextMessage()).toEqual({ ...answerA, peerId: peerA });

    const offerB = { peerId: peerB, sdp: { type: "offer", sdp: "b" } };
    sender.socket.send(JSON.stringify(offerB));
    expect(await receiverB.nextMessage()).toEqual(offerB);

    receiverA.socket.close();
    expect(await sender.nextMessage()).toEqual({
      type: "peer-left",
      role: "recv",
      peerId: peerA,
    });
    expect(
      await (
        await fetch(`http://127.0.0.1:${server.port}/health`)
      ).json(),
    ).toEqual({ ok: true, rooms: 1, peers: 2 });

    sender.socket.close();
    expect(await receiverB.nextMessage()).toEqual({
      type: "peer-left",
      role: "send",
    });
    receiverB.socket.close();
  });

  test("isolates signaling between rooms", async () => {
    const server = startServer();
    const alphaSender = await connect(server, "send", {
      room: "alpha-room",
      key: "111111",
    });
    const alphaReceiver = await connect(server, "recv", {
      room: "alpha-room",
      key: "111111",
    });
    const betaSender = await connect(server, "send", {
      room: "beta-room",
      key: "222222",
    });
    const betaReceiver = await connect(server, "recv", {
      room: "beta-room",
      key: "222222",
    });

    expect(
      await (
        await fetch(`http://127.0.0.1:${server.port}/health`)
      ).json(),
    ).toEqual({ ok: true, rooms: 2, peers: 4 });

    alphaReceiver.socket.send(JSON.stringify({ type: "receiver-ready" }));
    betaReceiver.socket.send(JSON.stringify({ type: "receiver-ready" }));
    const alphaPeer = getPeerId(await alphaSender.nextMessage());
    getPeerId(await betaSender.nextMessage());

    const offer = {
      peerId: alphaPeer,
      sdp: { type: "offer", sdp: "alpha" },
    };
    alphaSender.socket.send(JSON.stringify(offer));
    expect(await alphaReceiver.nextMessage()).toEqual(offer);
    await Bun.sleep(10);
    expect(betaReceiver.pendingMessageCount()).toBe(0);

    alphaSender.socket.close();
    alphaReceiver.socket.close();
    betaSender.socket.close();
    betaReceiver.socket.close();
    await Promise.all([
      alphaSender.closed,
      alphaReceiver.closed,
      betaSender.closed,
      betaReceiver.closed,
    ]);
    expect(
      await (
        await fetch(`http://127.0.0.1:${server.port}/health`)
      ).json(),
    ).toEqual({ ok: true, rooms: 0, peers: 0 });
  });

  test("rejects a valid room with the wrong access code", async () => {
    const server = startServer();
    const receiver = await connect(server, "recv", {
      room: "secure-room",
      key: "123456",
    });
    const intruder = await connect(server, "send", {
      room: "secure-room",
      key: "654321",
    });

    expect((await intruder.closed).code).toBe(4003);
    receiver.socket.close();
  });

  test("caps each room at eight receivers", async () => {
    const server = startServer();
    const receivers: SocketClient[] = [];
    for (let index = 0; index < 8; index += 1) {
      receivers.push(await connect(server, "recv"));
    }

    const overflow = await connect(server, "recv");
    expect((await overflow.closed).code).toBe(4010);
    expect(
      await (
        await fetch(`http://127.0.0.1:${server.port}/health`)
      ).json(),
    ).toEqual({ ok: true, rooms: 1, peers: 8 });

    for (const receiver of receivers) receiver.socket.close();
  });
});
