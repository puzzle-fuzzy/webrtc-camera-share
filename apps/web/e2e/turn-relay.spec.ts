import { expect, test, type Page } from "@playwright/test"

declare global {
  interface Window {
    __turnE2ePeerConnections?: RTCPeerConnection[]
  }
}

test.skip(
  !process.env.TURN_E2E,
  "Set TURN_E2E=1 with a configured TURN deployment to run the relay gate.",
)

function collectUnexpectedErrors(page: Page, errors: string[]) {
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
  page.on("pageerror", (error) => errors.push(error.message))
}

test("uses a TURN relay when relay-only policy is requested", async ({
  context,
  page: senderPage,
  baseURL,
}) => {
  if (!baseURL) throw new Error("Playwright baseURL is required")

  await context.addInitScript(() => {
    const NativePeerConnection = window.RTCPeerConnection
    const connections: RTCPeerConnection[] = []
    window.__turnE2ePeerConnections = connections
    window.RTCPeerConnection = new Proxy(NativePeerConnection, {
      construct(target, argumentsList) {
        const configuration = (argumentsList[0] ?? {}) as RTCConfiguration
        const connection = Reflect.construct(target, [
          { ...configuration, iceTransportPolicy: "relay" },
        ]) as RTCPeerConnection
        connections.push(connection)
        return connection
      },
    })
  })

  await context.grantPermissions(["camera"], { origin: new URL(baseURL).origin })
  const browserErrors: string[] = []
  collectUnexpectedErrors(senderPage, browserErrors)

  await senderPage.goto("/send")
  const receiverHref = await senderPage
    .getByRole("link", { name: "打开接收端" })
    .getAttribute("href")
  if (!receiverHref) throw new Error("receiver link was not generated")

  await senderPage.getByRole("button", { name: "开始发送" }).click()
  await expect(senderPage.getByRole("status")).toContainText("等待接收端")

  const receiverPage = await context.newPage()
  collectUnexpectedErrors(receiverPage, browserErrors)
  await receiverPage.goto(new URL(receiverHref, baseURL).href)
  await receiverPage.getByRole("button", { name: "开始接收" }).click()

  await expect(senderPage.getByRole("status")).toContainText(
    "1 个接收端已连接",
    { timeout: 45_000 },
  )
  await expect(receiverPage.getByRole("status")).toContainText(
    /视频连接已建立|已收到视频画面/,
    { timeout: 45_000 },
  )

  const selectedPairs = await senderPage.evaluate(() => {
    return Promise.all(
      (window.__turnE2ePeerConnections ?? []).map(async (connection) => {
        const report = await connection.getStats()
      const candidates = new Map<string, RTCIceCandidateStats>()
      let pair: RTCIceCandidatePairStats | undefined
      report.forEach((stat) => {
        if (stat.type === "local-candidate" || stat.type === "remote-candidate") {
          candidates.set(stat.id, stat as RTCIceCandidateStats)
        }
        if (
          stat.type === "candidate-pair" &&
          stat.state === "succeeded" &&
          (stat.nominated || stat.selected)
        ) {
          pair = stat as RTCIceCandidatePairStats
        }
      })
      if (!pair) return []
      return [
        {
          localType: candidates.get(pair.localCandidateId)?.candidateType,
          remoteType: candidates.get(pair.remoteCandidateId)?.candidateType,
        },
      ]
      }),
    ).then((pairs) => pairs.flat())
  })

  expect(selectedPairs.length).toBeGreaterThan(0)
  expect(selectedPairs).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ localType: "relay", remoteType: "relay" }),
    ]),
  )
  expect(browserErrors).toEqual([])
})
