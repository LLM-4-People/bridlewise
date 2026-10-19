/**
 * nanostores shared state: the installed extension (add-on) list.
 *
 * Fed ONLY by client.ts (`setExtensions`) at the `listExtensions` fetch —
 * the SAME response the ExtensionsPanel renders, so the module readout and
 * the panel describe one fetch, never two paths that can drift. This store
 * is the seam whose absence used to keep `legacy.extensions-panel` on the
 * headline exemption list.
 *
 * Extensions are installation-scoped (the server's configuration file),
 * not per-project or per-chat, so there is no context-switch reset — only
 * the logout reset every store carries.
 *
 * @global-store installation-wide: the extension list comes from the
 * server's configuration file and is identical for every project and every
 * chat — a chat or project switch changes nothing about what is installed.
 *
 * Plain .ts — Node-testable via Vitest.
 */

import { atom, type WritableAtom } from "nanostores";

import { registerReset } from "./store-registry";

/** One configured extension, as the server lists it. */
export type ExtensionView = Readonly<{
  name: string;
  type: string;
  /** Server-declared status: "active" | "disabled". */
  status: string;
  version: string;
  description: string | null;
}>;

/** `null` until the first successful fetch — "not checked yet", which is a
 * DIFFERENT fact from "no add-ons installed" (an empty list). */
export const extensionList: WritableAtom<readonly ExtensionView[] | null> =
  atom<readonly ExtensionView[] | null>(null);

export function setExtensions(list: readonly ExtensionView[] | null): void {
  extensionList.set(list);
}

/**
 * Reset to the unfetched state. Called by the single store-reset owner
 * (`resetAllStores`) on logout.
 */
export function resetExtensions(): void {
  extensionList.set(null);
}

registerReset("extensions", resetExtensions);
