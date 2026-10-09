import { invoke } from "@tauri-apps/api/core";
import { sniffImageMime } from "../../files/model/filePreview";
import { getGithubHost, isGithubDotcom } from "./githubHost";

export type InboxMediaKind = "image" | "video";
export type InboxMediaType = { kind: InboxMediaKind; mime: string };

// Each file can be up to 25 MB, so keep recent bytes under a total budget
// instead of every image and video ever shown. Requests in flight are shared.
const MEDIA_CACHE_BYTES = 32 * 1024 * 1024;
const mediaCache = new Map<string, Uint8Array>();
const mediaRequests = new Map<string, Promise<Uint8Array>>();
let mediaCacheBytes = 0;

/**
 * The normalized URL of a remote image an issue/PR body may show: any HTTPS
 * host, fetched through the backend, except credentials, IP literals and
 * localhost. Normalizing first turns `https://0x7f.1/` into `127.0.0.1`, so the
 * backend sees the address the URL really names.
 */
export function remoteImageUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (pathHasDotDot(url.pathname)) return null;
  const host = url.hostname.replace(/\.$/, "").toLowerCase();
  if (!host || host === "localhost" || host.startsWith("[")) return null;
  if (/^[0-9.]+$/.test(host)) return null;
  return url.href;
}

/**
 * Upload URLs GitHub and Linear put in issue bodies. Unlike any image, a bare
 * link to one of these is embedded too, since that is how videos appear.
 */
export function isInboxMediaUrl(
  value: string,
  githubHost = getGithubHost(),
): boolean {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  const host = url.hostname.replace(/\.$/, "").toLowerCase();
  if (pathHasDotDot(url.pathname)) return false;
  if (host === "uploads.linear.app" || host.endsWith(".uploads.linear.app")) {
    return true;
  }
  if (
    host === "githubusercontent.com" ||
    host.endsWith(".githubusercontent.com")
  ) {
    return true;
  }
  const enterprise = isGithubDotcom(githubHost) ? null : githubHost;
  if (enterprise && host === `media.${enterprise}`) return true;
  const bare = host.startsWith("www.") ? host.slice(4) : host;
  if (bare !== "github.com" && bare !== enterprise) return false;
  const path = url.pathname.toLowerCase();
  if (path.startsWith("/user-attachments/")) return true;
  if (enterprise && bare === enterprise && path.startsWith("/storage/")) {
    return true;
  }
  const parts = path.split("/").filter(Boolean);
  return (
    parts.length >= 4 &&
    parts[2] === "assets" &&
    /^[0-9]+$/.test(parts[3] ?? "")
  );
}

export function sniffInboxMedia(bytes: Uint8Array): InboxMediaType | null {
  const mime = sniffImageMime(bytes);
  if (mime) return { kind: "image", mime };
  if (isSvg(bytes)) return { kind: "image", mime: "image/svg+xml" };
  return sniffVideoType(bytes);
}

// Badges and diagrams in READMEs are often SVG. Shown through <img>, an SVG
// runs no script, so a markup lead that opens an <svg> root is enough.
function isSvg(bytes: Uint8Array): boolean {
  const head = new TextDecoder()
    .decode(bytes.subarray(0, 1024))
    .replace(/^\uFEFF/, "")
    .trimStart();
  return head.startsWith("<") && /<svg[\s>]/i.test(head);
}

export function fetchInboxMedia(url: string): Promise<Uint8Array> {
  const key = url.trim();
  const cached = mediaCache.get(key);
  if (cached) {
    mediaCache.delete(key);
    mediaCache.set(key, cached);
    return Promise.resolve(cached);
  }
  const inFlight = mediaRequests.get(key);
  if (inFlight) return inFlight;
  const pending = invoke<ArrayBuffer>("fetch_inbox_media", { url: key }).then(
    (buffer) => {
      const bytes = new Uint8Array(buffer);
      rememberMedia(key, bytes);
      return bytes;
    },
  );
  mediaRequests.set(key, pending);
  const settle = () => {
    mediaRequests.delete(key);
  };
  pending.then(settle, settle);
  return pending;
}

function rememberMedia(key: string, bytes: Uint8Array) {
  if (bytes.byteLength > MEDIA_CACHE_BYTES) return;
  const previous = mediaCache.get(key);
  if (previous) {
    mediaCache.delete(key);
    mediaCacheBytes -= previous.byteLength;
  }
  mediaCache.set(key, bytes);
  mediaCacheBytes += bytes.byteLength;
  for (const [oldest, old] of mediaCache) {
    if (mediaCacheBytes <= MEDIA_CACHE_BYTES) break;
    mediaCache.delete(oldest);
    mediaCacheBytes -= old.byteLength;
  }
}

function sniffVideoType(bytes: Uint8Array): InboxMediaType | null {
  if (
    bytes.length >= 12 &&
    startsWith(bytes.subarray(4), [0x66, 0x74, 0x79, 0x70])
  ) {
    const brand = String.fromCharCode(...bytes.subarray(8, 12));
    if (brand === "avif" || brand === "avis") return null;
    return {
      kind: "video",
      mime: brand === "qt  " ? "video/quicktime" : "video/mp4",
    };
  }
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) {
    return { kind: "video", mime: "video/webm" };
  }
  return null;
}

function pathHasDotDot(path: string): boolean {
  return path.split("/").some((segment) => {
    const lower = segment.toLowerCase();
    return (
      lower === ".." ||
      lower === "%2e%2e" ||
      lower === "%2e." ||
      lower === ".%2e"
    );
  });
}

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  if (bytes.length < magic.length) return false;
  return magic.every((byte, index) => bytes[index] === byte);
}
