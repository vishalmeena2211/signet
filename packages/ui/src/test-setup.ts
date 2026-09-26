// Unmount between tests.
//
// Testing Library only registers its automatic cleanup when Vitest globals are
// enabled, and this package uses explicit imports — so without this, every
// render accumulates in the same document and queries start matching elements
// from earlier tests. That failure mode is confusing (a test fails because of a
// previous one), so the cleanup is wired explicitly.

import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});
