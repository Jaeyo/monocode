import type { TaskLink } from "./tasks";

/** `o/r#7 Fix login`, `ENG-12 Crash`, or the URL when nothing else is known. */
export function linkLabel(link: TaskLink): string {
  const ref =
    link.identifier ??
    (link.number != null ? `${link.repo}#${link.number}` : link.repo);
  return link.title ? `${ref ? `${ref} ` : ""}${link.title}` : ref || link.url;
}
