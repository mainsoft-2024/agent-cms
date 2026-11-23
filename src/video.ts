/**
 * Video embeds for `:::video` blocks (0.21.0). Only hosts on the allow list are embedded;
 * YouTube is drawn through youtube-nocookie.com. No network requests: the address is turned
 * into the player address by its shape alone.
 */

/** Hosts allowed when the app says nothing (`createCms({ video: { hosts } })` adds more). */
export const DEFAULT_VIDEO_HOSTS = ["youtube.com", "youtu.be", "vimeo.com"] as const;

/** The host of an https URL, lowercased, without `www.` / `m.`; null for anything else. */
export function videoHost(src: string): string | null {
  try {
    const u = new URL(src);
    if (u.protocol !== "https:") return null;
    return u.hostname.toLowerCase().replace(/^(www|m)\./, "");
  } catch {
    return null;
  }
}

/** Whether `host` is on the list (a listed host also allows its subdomains). */
export function hostAllowed(host: string, hosts: readonly string[]): boolean {
  return hosts.some((h) => {
    const x = h.toLowerCase().replace(/^\*\./, "").replace(/^www\./, "");
    return host === x || host.endsWith(`.${x}`);
  });
}

/** The player address for an allowed video URL, or null (not https, not allowed, or not a video address). */
export function videoEmbed(src: string, hosts: readonly string[] = DEFAULT_VIDEO_HOSTS): string | null {
  const host = videoHost(src);
  if (!host || !hostAllowed(host, hosts)) return null;
  const u = new URL(src);
  const id = /^[\w-]{6,20}$/;
  if (host === "youtu.be") {
    const v = u.pathname.slice(1);
    return id.test(v) ? `https://www.youtube-nocookie.com/embed/${v}` : null;
  }
  if (host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtube-nocookie.com") {
    const v = u.searchParams.get("v") ?? /^\/(?:embed|shorts|live)\/([\w-]+)/.exec(u.pathname)?.[1] ?? "";
    return id.test(v) ? `https://www.youtube-nocookie.com/embed/${v}` : null;
  }
  if (host === "vimeo.com" || host === "player.vimeo.com") {
    const v = /\/(?:video\/)?(\d{5,12})(?:\/|$)/.exec(u.pathname)?.[1];
    return v ? `https://player.vimeo.com/video/${v}` : null;
  }
  return u.toString();
}
