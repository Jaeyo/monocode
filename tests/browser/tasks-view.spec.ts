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

type StoredTask = {
  status: string;
  todos: { text: string; done: boolean }[];
  tags: string[];
  priority: string | null;
  document: string;
  links: { url: string }[];
};

const stored = (page: Page, title: string) =>
  page.evaluate(
    (name) =>
      (
        window as unknown as { taskNamed: (title: string) => StoredTask }
      ).taskNamed(name),
    title,
  );

test("edits fields in the side panel", async ({ page }) => {
  await choose(page);
  await card(page, "Write the spec").click();
  const panel = page.getByRole("complementary", {
    name: "Task: Write the spec",
  });
  await expect(panel).toBeVisible();

  const status = panel.getByRole("textbox", { name: "Status" });
  await status.fill("Reviewing with the team");
  await status.press("Enter");
  await expect
    .poll(async () => (await stored(page, "Write the spec")).status)
    .toBe("Reviewing with the team");
  await expect(card(page, "Write the spec")).toContainText(
    "Reviewing with the team",
  );

  await panel.getByRole("combobox", { name: "Priority" }).selectOption("low");
  await expect
    .poll(async () => (await stored(page, "Write the spec")).priority)
    .toBe("low");

  const tag = panel.getByRole("combobox", { name: "Add tag" });
  await tag.fill("backend");
  await tag.press("Enter");
  await expect
    .poll(async () => (await stored(page, "Write the spec")).tags)
    .toEqual(["backend"]);

  const todo = panel.getByRole("textbox", { name: "Add todo" });
  await todo.fill("Ship it");
  await todo.press("Enter");
  await expect(card(page, "Write the spec")).toContainText("1/3");

  await panel
    .getByRole("button", { name: "Delete todo Draft" })
    .click({ force: true });
  await expect
    .poll(async () =>
      (await stored(page, "Write the spec")).todos.map((t) => t.text),
    )
    .toEqual(["Review", "Ship it"]);

  await panel
    .getByRole("button", { name: "Remove link Spec PR" })
    .click({ force: true });
  await expect
    .poll(async () => (await stored(page, "Write the spec")).links)
    .toEqual([]);
});

test("saves the document only on save", async ({ page }) => {
  await choose(page);
  await card(page, "Fix login").click();
  const panel = page.getByRole("complementary", { name: "Task: Fix login" });
  const editor = panel.getByRole("textbox", { name: "Task document" });
  await editor.fill("# Plan\n\nRotate the session keys.");
  await expect(panel.getByText("Unsaved")).toBeVisible();
  expect((await stored(page, "Fix login")).document).toBe("");
  await editor.press("ControlOrMeta+s");
  await expect(panel.getByText("Unsaved")).toHaveCount(0);
  expect((await stored(page, "Fix login")).document).toBe(
    "# Plan\n\nRotate the session keys.",
  );
});

test("renames a task from the panel", async ({ page }) => {
  await choose(page);
  await card(page, "Fix login").click();
  const panel = page.getByRole("complementary", { name: "Task: Fix login" });
  await panel.getByRole("button", { name: "Fix login" }).click();
  const input = panel.getByRole("textbox", { name: "Task title" });
  await input.fill("Fix sign-in");
  await input.press("Enter");
  await expect(card(page, "Fix sign-in")).toBeVisible();
  await expect(
    page.getByRole("complementary", { name: "Task: Fix sign-in" }),
  ).toBeVisible();
});

test("offers setup from the Inbox before a folder is chosen", async ({
  page,
}) => {
  await page.goto("/tests/browser/tasks-view.html");
  const inbox = page.locator("[data-inbox-fixture]");
  await inbox.getByRole("button", { name: "Add to Task" }).click();
  await expect(page.getByText("Tasks are not set up yet.")).toBeVisible();
});

test("links an Inbox item to an existing task and to a new one", async ({
  page,
}) => {
  await choose(page);
  const inbox = page.locator("[data-inbox-fixture]");
  await inbox.getByRole("button", { name: "Add to Task" }).click();
  const picker = page.getByRole("dialog", { name: "Add to task" });
  await picker.getByRole("textbox", { name: "Find a task" }).fill("fix");
  await picker.getByRole("option", { name: /Fix login/ }).click();
  await expect(page.getByText("Linked to “Fix login”.")).toBeVisible();
  await expect(card(page, "Fix login")).toContainText("Crash on start");
  // The linked task shows in the header and opens from there.
  await inbox.getByRole("button", { name: "Fix login" }).click();
  expect(
    await page.evaluate(
      () => (window as unknown as { opened: string[] }).opened,
    ),
  ).toEqual(["Fix login"]);

  await inbox.getByRole("button", { name: "Add to another Task" }).click();
  await page
    .getByRole("dialog", { name: "Add to task" })
    .getByRole("button", { name: "New task" })
    .click();
  const create = page.getByRole("dialog", { name: "Create task" });
  await create
    .getByRole("textbox", { name: "Task title" })
    .fill("Crash triage");
  await create.getByRole("button", { name: "Create" }).click();
  await expect(card(page, "Crash triage")).toContainText("Crash on start");
  await expect(
    inbox.getByRole("button", { name: "Crash triage" }),
  ).toBeVisible();
});

test("offers to finish a task whose pull requests merged", async ({ page }) => {
  await choose(page);
  const spec = card(page, "Write the spec");
  await expect(spec).toContainText("merged");
  await expect(spec).toContainText("Linked pull requests are finished.");
  await spec.getByRole("button", { name: "Move", exact: true }).click();
  await expect
    .poll(async () => (await titles(page)).Done)
    .toEqual(["Write the spec", "Shipped"]);
});

test("forgets the suggestion once dismissed", async ({ page }) => {
  await choose(page);
  const spec = card(page, "Write the spec");
  await spec.getByRole("button", { name: "Dismiss" }).click();
  await expect(spec).not.toContainText("Linked pull requests are finished.");
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(spec).toContainText("merged");
  await expect(spec).not.toContainText("Linked pull requests are finished.");
});

test("starts a session with the task as context and lists it", async ({
  page,
}) => {
  await choose(page);
  await card(page, "Write the spec").click();
  const panel = page.getByRole("complementary", {
    name: "Task: Write the spec",
  });
  await panel.getByRole("button", { name: "Start session" }).click();
  const started = await page.evaluate(
    () =>
      (
        window as unknown as {
          started: { kind?: string; sourceCwd?: string; body: string }[];
        }
      ).started,
  );
  expect(started).toHaveLength(1);
  expect(started[0].kind).toBe("task");
  expect(started[0].sourceCwd).toBe("/code/r");
  expect(started[0].body).toContain(
    "File: /tmp/fixture-tasks/TODO/Write the spec.md",
  );
  await expect(
    panel.getByRole("button", { name: /Spec session/ }),
  ).toBeVisible();
  await panel.getByRole("button", { name: /Spec session/ }).click();
  expect(
    await page.evaluate(
      () => (window as unknown as { openedSessions: string[] }).openedSessions,
    ),
  ).toEqual(["S-new"]);
});

test("searches and filters, opening folded columns that match", async ({
  page,
}) => {
  await choose(page);
  const search = page.getByRole("textbox", { name: "Search tasks" });
  await page.locator("body").click({ position: { x: 600, y: 700 } });
  await page.keyboard.press("ControlOrMeta+f");
  await expect(search).toBeFocused();
  await search.fill("spec");
  await expect(card(page, "Write the spec")).toBeVisible();
  await expect(card(page, "Fix login")).toHaveCount(0);

  // Done is folded, but a match inside it shows.
  await search.fill("shipped");
  await expect(card(page, "Shipped")).toBeVisible();

  await page.getByRole("button", { name: "Clear filters" }).click();
  await page.getByRole("button", { name: "Overdue" }).click();
  await expect(card(page, "Fix login")).toBeVisible();
  await expect(card(page, "Write the spec")).toHaveCount(0);
  await page
    .getByRole("combobox", { name: "Filter by links" })
    .selectOption("with");
  await expect(card(page, "Fix login")).toHaveCount(0);
});

test("creates a task from the quick dialog without leaving", async ({
  page,
}) => {
  await choose(page);
  await page.getByRole("button", { name: "Quick task" }).click();
  const dialog = page.getByRole("dialog", { name: "New Task" });
  await dialog.getByRole("textbox", { name: "Task title" }).fill("Call vendor");
  await dialog
    .getByRole("combobox", { name: "Column" })
    .selectOption("In Progress");
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByText("Created “Call vendor” in In Progress."),
  ).toBeVisible();
  expect((await titles(page))["In Progress"]).toEqual(["Call vendor"]);
});
