import { mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

import { expect, test, type Page } from "@playwright/test"

type BrowserRole = "sender" | "receiver"

type BrowserTarget = {
  page: Page
  role: BrowserRole
  index: number
}

declare global {
  interface Window {
    __soakPeerConnections?: RTCPeerConnection[]
  }
}

test.skip(
  !process.env.SOAK_RECEIVERS,
  "Run this scenario through scripts/soak.py so its bounds and credentials are enforced.",
)

function requiredInteger(name: string): number {
  const value = Number(process.env[name])
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

function collectUnexpectedErrors(
  page: Page,
  role: BrowserRole,
  errors: BrowserRole[],
) {
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(role)
  })
  page.on("pageerror", () => errors.push(role))
}

async function browserSample(target: BrowserTarget) {
  return target.page.evaluate(
    async ({ role, index }) => {
      const peerConnections = window.__soakPeerConnections ?? []
      const connections = await Promise.all(
        peerConnections.map(async (connection) => {
          const report = await connection.getStats()
          let selectedCandidatePair:
            | Record<string, number | string | undefined>
            | undefined
          let inboundVideo:
            | Record<string, number | string | undefined>
            | undefined
          let outboundVideo:
            | Record<string, number | string | undefined>
            | undefined

          report.forEach((stat) => {
            if (
              stat.type === "candidate-pair" &&
              stat.state === "succeeded" &&
              (stat.nominated || stat.selected)
            ) {
              selectedCandidatePair = {
                currentRoundTripTime: stat.currentRoundTripTime,
                availableOutgoingBitrate: stat.availableOutgoingBitrate,
                bytesSent: stat.bytesSent,
                bytesReceived: stat.bytesReceived,
              }
            } else if (
              stat.type === "inbound-rtp" &&
              stat.kind === "video" &&
              !stat.isRemote
            ) {
              inboundVideo = {
                bytesReceived: stat.bytesReceived,
                framesDecoded: stat.framesDecoded,
                framesDropped: stat.framesDropped,
                packetsLost: stat.packetsLost,
              }
            } else if (
              stat.type === "outbound-rtp" &&
              stat.kind === "video" &&
              !stat.isRemote
            ) {
              outboundVideo = {
                bytesSent: stat.bytesSent,
                framesEncoded: stat.framesEncoded,
                packetsSent: stat.packetsSent,
                qualityLimitationReason: stat.qualityLimitationReason,
              }
            }
          })

          return {
            connectionState: connection.connectionState,
            iceConnectionState: connection.iceConnectionState,
            selectedCandidatePair,
            inboundVideo,
            outboundVideo,
          }
        }),
      )
      return { role, index, connections }
    },
    { role: target.role, index: target.index },
  )
}

test("samples a bounded multi-receiver WebRTC session", async ({
  baseURL,
  context,
  page: senderPage,
  request,
}) => {
  if (!baseURL) throw new Error("Playwright baseURL is required")
  const receivers = requiredInteger("SOAK_RECEIVERS")
  const durationSeconds = requiredInteger("SOAK_DURATION_SECONDS")
  const outputFile = process.env.SOAK_OUTPUT_FILE
  const metricsToken = process.env.SOAK_METRICS_TOKEN
  if (!outputFile || !metricsToken) {
    throw new Error("SOAK_OUTPUT_FILE and SOAK_METRICS_TOKEN are required")
  }
  test.setTimeout((durationSeconds + 90) * 1_000)

  await context.addInitScript(() => {
    const NativePeerConnection = window.RTCPeerConnection
    const connections: RTCPeerConnection[] = []
    window.__soakPeerConnections = connections
    window.RTCPeerConnection = new Proxy(NativePeerConnection, {
      construct(target, argumentsList) {
        const connection = Reflect.construct(target, argumentsList)
        connections.push(connection)
        return connection
      },
    })
  })
  await context.grantPermissions(["camera"], { origin: new URL(baseURL).origin })

  const browserErrors: BrowserRole[] = []
  collectUnexpectedErrors(senderPage, "sender", browserErrors)
  await senderPage.goto("/send")
  const receiverHref = await senderPage
    .getByRole("link", { name: "打开接收端" })
    .getAttribute("href")
  if (!receiverHref) throw new Error("receiver link was not generated")
  await senderPage.getByRole("button", { name: "开始发送" }).click()
  await expect(senderPage.getByRole("status")).toContainText("等待接收端")

  const targets: BrowserTarget[] = [
    { page: senderPage, role: "sender", index: 0 },
  ]
  for (let index = 1; index <= receivers; index += 1) {
    const receiverPage = await context.newPage()
    collectUnexpectedErrors(receiverPage, "receiver", browserErrors)
    await receiverPage.goto(new URL(receiverHref, baseURL).href)
    await receiverPage.getByRole("button", { name: "开始接收" }).click()
    targets.push({ page: receiverPage, role: "receiver", index })
  }

  await expect(senderPage.getByRole("status")).toContainText(
    `${receivers} 个接收端已连接`,
    { timeout: 30_000 },
  )
  for (const { page, role } of targets) {
    if (role === "receiver") {
      await expect(page.getByRole("status")).toContainText(
        /视频连接已建立|已收到视频画面/,
      )
    }
    await expect
      .poll(() =>
        page.locator("video").evaluate((video) => {
          const stream = (video as HTMLVideoElement).srcObject
          return stream instanceof MediaStream && stream.getVideoTracks().length > 0
        }),
      )
      .toBe(true)
  }

  const startedAt = new Date()
  const started = Date.now()
  const samples: unknown[] = []
  while (true) {
    const elapsedMilliseconds = Date.now() - started
    const [healthResponse, metricsResponse, browsers] = await Promise.all([
      request.get("/health"),
      request.get("/metrics", {
        headers: { Authorization: `Bearer ${metricsToken}` },
      }),
      Promise.all(targets.map(browserSample)),
    ])
    expect(healthResponse.ok()).toBe(true)
    expect(metricsResponse.ok()).toBe(true)
    samples.push({
      elapsedSeconds: Number((elapsedMilliseconds / 1_000).toFixed(3)),
      server: {
        health: await healthResponse.json(),
        metrics: await metricsResponse.json(),
      },
      browsers,
    })
    if (elapsedMilliseconds >= durationSeconds * 1_000) break
    await senderPage.waitForTimeout(
      Math.min(1_000, durationSeconds * 1_000 - elapsedMilliseconds),
    )
  }

  const summary = {
    schemaVersion: 1,
    receivers,
    durationSeconds,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    browserErrorCount: browserErrors.length,
    samples,
  }
  await mkdir(dirname(outputFile), { recursive: true })
  await writeFile(outputFile, `${JSON.stringify(summary, null, 2)}\n`, "utf8")

  expect(browserErrors).toEqual([])
  for (const sample of samples as Array<{
    browsers: Array<{
      connections: Array<{ connectionState: RTCPeerConnectionState }>
    }>
  }>) {
    for (const browser of sample.browsers) {
      expect(browser.connections.length).toBeGreaterThan(0)
      expect(
        browser.connections.every(
          ({ connectionState }) => connectionState === "connected",
        ),
      ).toBe(true)
    }
  }
})
