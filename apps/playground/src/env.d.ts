/** Git commit + engine hash, set by vite.config.ts (MULTIPLAYER.md §6.4). */
declare const __BUILD_ID__: string;

/** Build-time settings for hosted builds (docs/PUBLISHING-ITCH.md §2); both optional. */
interface ImportMetaEnv {
  /** A fixed relay, e.g. wss://cosmic-relay.onrender.com. Unset: the page's own origin is the relay. */
  readonly VITE_RELAY_URL?: string;
  /** The page testers open (the itch page); invites say "Go to <url> and enter code …". */
  readonly VITE_SHARE_URL?: string;
}

/** Developer config files (docs/DEV-MODE.md §3.2), served by dev-files.ts; null in production builds. */
declare module "virtual:dev-config" {
  const files: { file: unknown; local: unknown; error?: string };
  export default files;
}
