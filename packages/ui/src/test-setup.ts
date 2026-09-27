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

/**
 * ResizeObserver, which jsdom does not implement.
 *
 * React Flow measures the DOM to lay a graph out, so without this every canvas render
 * throws ReferenceError before the component is reached. A no-op is the honest stub:
 * jsdom has no layout to observe, so nothing it reported would be true. Tests around the
 * canvas therefore assert on its accessible description rather than on node geometry —
 * measuring a fake layout would only ever be testing this stub.
 */
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}
