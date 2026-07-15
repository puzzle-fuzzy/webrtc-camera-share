import { createServer } from "./server.ts";

function getPort(value: string | undefined): number {
  if (!value) return 5011;

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`PORT 必须是 1 到 65535 之间的整数，当前值：${value}`);
  }
  return port;
}

const port = getPort(Bun.env.PORT);
const hostname = Bun.env.HOST ?? "0.0.0.0";
const server = createServer({ port, hostname });

console.log(`Running on http://127.0.0.1:${server.port}`);
console.log(`  发送端: http://127.0.0.1:${server.port}/send.html`);
console.log(`  接收端: http://127.0.0.1:${server.port}/recv.html`);
