import { expect, test, type Page } from "@playwright/test";

type Fixture = Window & {
  calls: string[];
  columnTitles: () => Record<string, string[]>;
};

const titles = (page: Page) =>
  page.evaluate(() => (window as unknown as Fixture).columnTitles());

const card = (page: Page, title: string) =>
  page.locator("[data-task-id]", { hasText: title });

const section = (page: Page, name: string) =>
  page.locator(`section[aria-label="${name}"]`);

async function choose(page: Page) {
  await page.goto("/tests/browser/tasks-view.html");
  await expect(page.getByText("Choose a folder for Tasks")).toBeVisible();
  await page.getByRole("button", { name: "Choose folder…" }).click();
  await expect(card(page, "Write the spec")).toBeVisible();
}

test("sets up a folder and lists the columns", async ({ page }) => {
  await choose(page);
  await expect(section(page, "TODO")).toBeVisible();
  await expect(section(page, "In Progress")).toBeVisible();
  // The done column starts collapsed.
  await expect(card(page, "Shipped")).toHaveCount(0);
  await page.getByRole("button", { name: "Expand Done" }).click();
  await expect(card(page, "Shipped")).toBeVisible();

  const spec = card(page, "Write the spec");
  await expect(spec).toContainText("1/2");
  await expect(spec).toContainText("Waiting on API review");
  await expect(spec).toContainText("Spec PR");
  await expect(card(page, "Fix login")).toContainText("Jan 1, 2000");
});

test("toggles a todo from the list", async ({ page }) => {
  await choose(page);
  const review = card(page, "Write the spec").getByRole("checkbox", {
    name: "Review",
  });
  await expect(review).toHaveAttribute("aria-checked", "false");
  await review.click();
  await expect(review).toHaveAttribute("aria-checked", "true");
  await expect(card(page, "Write the spec")).toContainText("2/2");
});

test("creates a task in the first column", async ({ page }) => {
  await choose(page);
  await page.getByRole("button", { name: "New task", exact: true }).click();
  const input = page.getByRole("textbox", { name: "New task title" });
  await input.fill("새 작업");
  await input.press("Enter");
  await expect(card(page, "새 작업")).toBeVisible();
  expect((await titles(page)).TODO[0]).toBe("새 작업");
});

test("drags a task into another column and undoes it", async ({ page }) => {
  await choose(page);
  const from = await card(page, "Fix login").boundingBox();
  const to = await section(page, "In Progress").boundingBox();
  if (!from || !to) throw new Error("missing boxes");
  await page.mouse.move(from.x + 40, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + 40, to.y + to.height - 4, { steps: 15 });
  await page.mouse.up();
  await expect(
    section(page, "In Progress").locator("[data-task-id]"),
  ).toHaveText(/Fix login/);
  expect((await titles(page))["In Progress"]).toEqual(["Fix login"]);
  await expect(
    page.getByText("Moved “Fix login” to In Progress."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect
    .poll(async () => (await titles(page)).TODO)
    .toEqual(["Write the spec", "Fix login"]);
});

test("moves with the context menu and undoes with the keyboard", async ({
  page,
}) => {
  await choose(page);
  await card(page, "Fix login").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to" }).hover();
  await page.getByRole("menuitem", { name: "In Progress" }).click();
  await expect
    .poll(async () => (await titles(page))["In Progress"])
    .toEqual(["Fix login"]);
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("ControlOrMeta+z");
  await expect
    .poll(async () => (await titles(page)).TODO)
    .toContain("Fix login");
});

test("deletes a task and restores it from the toast", async ({ page }) => {
  await choose(page);
  await card(page, "Fix login").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await expect(card(page, "Fix login")).toHaveCount(0);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(card(page, "Fix login")).toBeVisible();
});

test("reorders columns by dragging a header", async ({ page }) => {
  await choose(page);
  const from = await section(page, "Done").locator("header h2").boundingBox();
  const to = await section(page, "TODO").locator("header").boundingBox();
  if (!from || !to) throw new Error("missing boxes");
  await page.mouse.move(from.x + 5, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + 60, to.y + 2, { steps: 15 });
  await page.mouse.up();
  await expect
    .poll(async () => Object.keys(await titles(page)))
    .toEqual(["Done", "TODO", "In Progress"]);
});

test("renames a column from its menu", async ({ page }) => {
  await choose(page);
  await section(page, "In Progress")
    .locator("header")
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const input = page.getByRole("textbox", { name: "Column name" });
  await input.fill("Doing");
  await input.press("Enter");
  await expect(section(page, "Doing")).toBeVisible();
});
