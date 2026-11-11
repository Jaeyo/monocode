import { createRoot } from "react-dom/client";
import { emit } from "@tauri-apps/api/event";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { SettingsView } from "../../src/features/settings/ui/SettingsView";
import { HighlightedCodeBlock } from "../../src/features/sessions/ui/HighlightedCodeBlock";
import { initAppearance } from "../../src/features/settings/model/appearance";
import { EXTERNAL_THEME_CHANGED_EVENT } from "../../src/features/settings/model/externalTheme";
import "../../src/styles/index.css";

// Stands in for src-tauri/src/external_theme.rs: the file `colorTheme`
// selects, which the spec swaps the way Scene would.
let selected: { name: string; source: string } | null = null;

mockWindows("main");
mockIPC(
  (cmd) => {
    if (cmd === "read_external_theme") return selected;
    if (cmd === "clear_external_theme") {
      selected = null;
      return null;
    }
    return null;
  },
  { shouldMockEvents: true },
);

/** Writes the theme file and tells the windows, like Rust's watcher. */
async function selectTheme(theme: unknown | null) {
  selected =
    theme == null
      ? null
      : { name: "scene.json", source: JSON.stringify(theme) };
  await emit(EXTERNAL_THEME_CHANGED_EVENT);
}
Object.assign(window, { selectTheme });

initAppearance();

createRoot(document.getElementById("root")!).render(
  <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
    <div data-testid="code" className="agent-markdown" style={{ padding: 16 }}>
      <HighlightedCodeBlock
        code={'const greeting = "hello"; // say hi\n'}
        language="ts"
        isIncomplete={false}
        lineNumbers={false}
      />
    </div>
    <div style={{ display: "flex", flex: 1 }}>
      <SettingsView
        section="appearance"
        cwd="/repo"
        sessions={[]}
        onClose={() => {}}
        onSelectSection={() => {}}
        onOpenSession={() => {}}
        onArchiveSession={() => {}}
        onDeleteSession={() => {}}
        onOpenWhatsNew={() => {}}
      />
    </div>
  </div>,
);
