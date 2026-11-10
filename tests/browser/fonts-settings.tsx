import { createRoot } from "react-dom/client";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { SettingsView } from "../../src/features/settings/ui/SettingsView";
import { initAppearance } from "../../src/features/settings/model/appearance";
import "../../src/styles/index.css";

// Families every macOS/WebKit test machine has, plus one that is not real,
// so the picker, previews and the "not installed" check all have data.
mockWindows("main");
// mockIPC wires invoke() but not the runtime flag isTauri() reads, and the
// picker only asks Rust for fonts inside Tauri.
Object.assign(globalThis, { isTauri: true });
mockIPC((cmd) => {
  if (cmd === "list_system_fonts") {
    return [
      { family: "Courier New", monospace: true },
      { family: "Georgia", monospace: false },
      { family: "Helvetica", monospace: false },
      { family: "Menlo", monospace: true },
      { family: "Times New Roman", monospace: false },
    ];
  }
  return null;
});

initAppearance();

/** Resolved family for one of the app's font variables, as a page reads it. */
function resolvedFont(name: string): string {
  const probe = document.createElement("span");
  probe.style.fontFamily = `var(${name})`;
  document.body.append(probe);
  const value = getComputedStyle(probe).fontFamily;
  probe.remove();
  return value;
}
Object.assign(window, { resolvedFont });

createRoot(document.getElementById("root")!).render(
  <div style={{ display: "flex", height: "100%" }}>
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
  </div>,
);
