/**
 * Test-only hook to reset the registration flag AND clear the shared exposure registry.
 */

import { clearAll } from "../shared/exposure/registry.ts";

let registered = false;

/** Test-only hook to reset the registration flag AND clear the shared exposure registry. */
export function resetToolResultRegistration(): void {
  if (registered) {
    clearAll();
  }
  registered = false;
}
