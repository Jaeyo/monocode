import { expect, test, type Page } from "@playwright/test";

type Fixture = Window & { resolvedFont: (name: string) => string };

const resolved = (page: Page, name: string) =>
  page.evaluate((n) => (window as unknown as Fixture).resolvedFont(n), name);

const sample = (page: Page, target: string) =>
  page.locator(`[data-font-sample="${target}"]`);

async function open(page: Page) {
  await page.goto("/tests/browser/fonts-settings.html");
  await expect(page.getByRole("heading", { name: "Fonts" })).toBeVisible();
}

test("defaults resolve to the built-in stacks through var()", async ({
  page,
}) => {
  await open(page);
  expect(await resolved(page, "--font-sans")).toContain("system-ui");
  expect(await resolved(page, "--font-mono")).toContain("ui-monospace");
  expect(await resolved(page, "--font-terminal")).toContain("JetBrainsMono");
  const bodyFont = await page.evaluate(
    () => getComputedStyle(document.body).fontFamily,
  );
  expect(bodyFont).toContain("system-ui");
});

test("picking fonts restyles the app and its previews", async ({ page }) => {
  await open(page);

  await page.getByRole("button", { name: "Interface font: Default" }).click();
  await page.getByRole("option", { name: "Georgia" }).click();
  expect(await resolved(page, "--font-sans")).toMatch(/^"?Georgia"?, system-ui/);
  await expect
    .poll(() =>
      page.evaluate(() => getComputedStyle(document.body).fontFamily),
    )
    .toMatch(/^"?Georgia/);

  await page.getByRole("button", { name: "Code font: Default" }).click();
  // Fixed-pitch only by default: Georgia is filtered out.
  await expect(page.getByRole("option", { name: "Georgia" })).toHaveCount(0);
  await page.getByRole("option", { name: "Courier New" }).click();
  await expect(sample(page, "code")).toHaveCSS(
    "font-family",
    // WebKit serializes family names without quotes.
    /^"?Courier New"?, ui-monospace/,
  );

  await page.getByRole("button", { name: "Code font size: Default size" }).click();
  await page.getByRole("option", { name: "18px" }).click();
  await expect(sample(page, "code")).toHaveCSS("font-size", "18px");

  await page.getByRole("button", { name: "Terminal font: Default" }).click();
  await page
    .getByRole("combobox", { name: "Search or type a font name" })
    .fill("Menlo, monospace");
  await page.keyboard.press("Enter");
  await expect(sample(page, "terminal")).toHaveCSS(
    "font-family",
    "Menlo, monospace",
  );

  await page.getByRole("button", { name: "Restore defaults" }).click();
  expect(await resolved(page, "--font-sans")).toContain("system-ui");
  await expect(sample(page, "code")).toHaveCSS("font-size", "12px");
});

test("warns when a saved font is not installed", async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem("monocode.fontInterface", "Nope Sans"),
  );
  await open(page);
  await expect(
    page.getByText("“Nope Sans” isn't installed on this computer"),
  ).toBeVisible();
  // Fallback keeps the UI on the built-in stack.
  expect(await resolved(page, "--font-sans")).toMatch(/Nope Sans"?, system-ui/);
});
