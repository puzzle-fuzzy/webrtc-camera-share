import { expect, test, type Page } from "@playwright/test"

function collectUnexpectedErrors(page: Page, errors: string[]) {
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
  page.on("pageerror", (error) => errors.push(error.message))
}

test("shares a fake camera stream with a real receiver", async ({
  context,
  page: senderPage,
  baseURL,
}) => {
  if (!baseURL) throw new Error("Playwright baseURL is required")
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
  await expect(
    senderPage.getByRole("button", { name: "复制接收链接" }),
  ).toBeEnabled()

  const receiverPage = await context.newPage()
  collectUnexpectedErrors(receiverPage, browserErrors)
  await receiverPage.goto(new URL(receiverHref, baseURL).href)
  await receiverPage.getByRole("button", { name: "开始接收" }).click()

  await expect(senderPage.getByRole("status")).toContainText(
    "1 个接收端已连接",
  )
  await expect(receiverPage.getByRole("status")).toContainText(
    /视频连接已建立|已收到视频画面/,
  )

  for (const page of [senderPage, receiverPage]) {
    await expect
      .poll(() =>
        page.locator("video").evaluate((video) => {
          const stream = (video as HTMLVideoElement).srcObject
          return stream instanceof MediaStream && stream.getVideoTracks().length > 0
        }),
      )
      .toBe(true)
  }

  expect(browserErrors).toEqual([])
})
