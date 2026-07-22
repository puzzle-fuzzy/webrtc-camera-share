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

test("keeps actions usable across supported viewports", async ({ page }) => {
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 768, height: 1024 },
    { width: 1440, height: 1000 },
  ]) {
    await page.setViewportSize(viewport)
    await page.goto("/send")

    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    )
    expect(overflow).toBeLessThanOrEqual(0)

    const undersizedActions = await page
      .locator("button, [data-slot='card-footer'] a, main > nav a")
      .evaluateAll((actions) =>
        actions
          .map((action) => ({
            label: action.textContent?.trim() ?? "",
            height: action.getBoundingClientRect().height,
            width: action.getBoundingClientRect().width,
          }))
          .filter(({ height, width }) => height < 44 || width < 44),
      )
    expect(undersizedActions).toEqual([])
  }
})

test("shows keyboard focus and honors reduced motion", async ({ page }) => {
  await page.goto("/send")
  await page.keyboard.press("Tab")

  const focused = page.locator(":focus-visible")
  await expect(focused).toBeVisible()
  const focusStyle = await focused.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      boxShadow: style.boxShadow,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
    }
  })
  expect(
    focusStyle.boxShadow !== "none" ||
      (focusStyle.outlineStyle !== "none" && focusStyle.outlineWidth !== "0px"),
  ).toBe(true)

  await page.emulateMedia({ reducedMotion: "reduce" })
  const transitionProperty = await page
    .getByLabel("本地摄像头预览")
    .evaluate((video) => getComputedStyle(video).transitionProperty)
  expect(transitionProperty).toBe("none")
})

test("does not emit unexpected browser errors on static routes", async ({
  page,
}) => {
  const errors: string[] = []
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
  page.on("pageerror", (error) => errors.push(error.message))

  for (const route of ["/send", "/recv", "/about"]) {
    await page.goto(route)
  }
  expect(errors).toEqual([])
})
