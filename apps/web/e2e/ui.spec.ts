import { expect, test } from "@playwright/test"

test("uses a distinct title for every route", async ({ page }) => {
  await page.goto("/send")
  await expect(page).toHaveTitle("发送端 · 摄像头共享")

  await page.goto("/recv")
  await expect(page).toHaveTitle("接收端 · 摄像头共享")

  await page.goto("/about")
  await expect(page).toHaveTitle("关于 · 摄像头共享")
})

test("keeps validation errors out of the connection status", async ({ page }) => {
  await page.goto("/send")
  await page.getByLabel("房间 ID").fill("ab")
  await page.getByRole("button", { name: "开始发送" }).click()

  await expect(page.getByRole("alert")).toHaveCount(1)
  await expect(page.getByRole("alert")).toContainText("房间 ID")
  await expect(page.getByRole("status")).not.toContainText("房间 ID 需为")
})

test("keeps mobile actions usable without horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/send")

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)

  const undersizedActions = await page.locator("button, a").evaluateAll((actions) =>
    actions
      .map((action) => ({
        label: action.textContent?.trim() ?? "",
        height: action.getBoundingClientRect().height,
      }))
      .filter(({ height }) => height < 44),
  )
  expect(undersizedActions).toEqual([])
})
