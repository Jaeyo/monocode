import { expect, test, type Page } from "@playwright/test";

type Fixture = Window & { selectTheme: (theme: unknown | null) => Promise<void> };

const ANSI = [
  "#15161e", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#a9b1d6",
  "#414868", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#c0caf5",
];

function look(background: string, foreground: string) {
  return {
    interface: {
      background,
      surface: background,
      overlay: background,
      border: "#414868",
      foreground,
      muted: "#565f89",
      accent: "#ff9e64",
      selection: "#283457",
      cursor: foreground,
      currentLine: background,
      search: "#3d59a1",
      error: "#f7768e",
      warning: "#e0af68",
      success: "#9ece6a",
      info: "#7dcfff",
    },
    terminal: {
      background,
      foreground,
      cursor: foreground,
      cursorText: background,
      selectionBackground: "#283457",
      selectionForeground: foreground,
      ansi: ANSI,
    },
    syntax: {
      keyword: "#bb9af7",
      string: "#9ece6a",
      comment: { color: "#565f89", italic: true },
    },
  };
}

/** A two-look theme as Scene would write it for MonoCode. */
const TOKYO_NIGHT = {
  format: 1,
  theme: { id: "scene/tokyo-night", name: "Tokyo Night", version: "1.0.0" },
  mode: "dark",
  appearance: "dark",
  variants: {
    dark: look("#1a1b26", "#a9b1d6"),
    light: look("#e1e2e7", "#3760bf"),
  },
};

/** A color variable as a page paints it, in rgb(). */
const painted = (page: Page, expression: string) =>
  page.evaluate((value) => {
    const probe = document.createElement("span");
    probe.style.color = value;
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, expression);

const select = (page: Page, theme: unknown | null) =>
  page.evaluate(
    (value) => (window as unknown as Fixture).selectTheme(value),
    theme,
  );

const keywordColor = (page: Page) =>
  page
    .getByTestId("code")
    .locator(".markdown-code-token", { hasText: "const" })
    .first()
    .evaluate((node) => getComputedStyle(node).color);

async function open(page: Page) {
  await page.goto("/tests/browser/external-theme.html");
  await expect(page.getByRole("heading", { name: "Theme" })).toBeVisible();
  await expect(page.getByTestId("code").locator(".markdown-code-token").first())
    .toBeVisible();
}

test("Scene's theme recolors the app, code, and settings, and the built-in theme returns", async ({
  page,
}) => {
  await open(page);
  const builtInBackground = await painted(page, "var(--color-background-base)");
  const builtInKeyword = await keywordColor(page);
  await expect(page.getByText("External theme")).toHaveCount(0);

  await select(page, TOKYO_NIGHT);

  await expect
    .poll(() => painted(page, "var(--color-background-base)"))
    .toBe("rgb(26, 27, 38)");
  expect(await painted(page, "var(--color-content)")).toBe("rgb(169, 177, 214)");
  expect(await painted(page, "var(--color-accent)")).toBe("rgb(255, 158, 100)");
  await expect.poll(() => keywordColor(page)).toBe("rgb(187, 154, 247)");
  await expect(page.getByText("Tokyo Night (scene.json)")).toBeVisible();
  await expect(page.getByRole("slider", { name: "Hue" })).toBeDisabled();
  await page.screenshot({ path: "test-results/external-theme-dark.png" });

  await select(page, { ...TOKYO_NIGHT, mode: "light" });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.className))
    .toContain("theme-light");
  expect(await painted(page, "var(--color-background-base)")).toBe(
    "rgb(225, 226, 231)",
  );
  await page.screenshot({ path: "test-results/external-theme-light.png" });

  await page.getByRole("button", { name: "Use built-in theme" }).click();
  await expect(page.getByText("External theme")).toHaveCount(0);
  await expect
    .poll(() => painted(page, "var(--color-background-base)"))
    .toBe(builtInBackground);
  await expect.poll(() => keywordColor(page)).toBe(builtInKeyword);
  await expect(page.getByRole("slider", { name: "Hue" })).toBeEnabled();
  expect(
    await page.evaluate(() => document.documentElement.className),
  ).not.toContain("theme-light");
});

test("a theme file MonoCode can't read is reported and the built-in theme stays", async ({
  page,
}) => {
  await open(page);
  const builtInBackground = await painted(page, "var(--color-background-base)");

  await select(page, { ...TOKYO_NIGHT, format: 2 });

  await expect(page.getByText("format 2 is not supported")).toBeVisible();
  expect(await painted(page, "var(--color-background-base)")).toBe(
    builtInBackground,
  );
});
