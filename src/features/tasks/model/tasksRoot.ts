import { ask, open } from "@tauri-apps/plugin-dialog";
import { slash } from "../../../shared/lib/paths";
import { showToast } from "../../../shared/ui/Toasts";
import { taskErrorText } from "./tasks";
import { chooseTasksRoot, peekTasks } from "./tasksStore";

/**
 * Lets the user pick the tasks folder, from Settings or any setup prompt.
 * Switching folders leaves the old files where they are, so that is
 * confirmed first. Resolves to whether a folder was set.
 */
export async function promptForTasksRoot(): Promise<boolean> {
  const current = peekTasks().root;
  const picked = await open({
    directory: true,
    multiple: false,
    title: "Choose a folder for Tasks",
    defaultPath: current ?? undefined,
  });
  const root = typeof picked === "string" && picked ? slash(picked) : null;
  if (!root || root === current) return false;
  if (current) {
    const confirmed = await ask(
      `Tasks will be read from ${root}.\n\nThe task files in ${current} stay where they are; nothing is moved or copied.`,
      { title: "Change the Tasks folder?", kind: "warning", okLabel: "Change" },
    );
    if (!confirmed) return false;
  }
  try {
    await chooseTasksRoot(root);
    return true;
  } catch (error) {
    showToast(taskErrorText(error), { tone: "error" });
    return false;
  }
}
