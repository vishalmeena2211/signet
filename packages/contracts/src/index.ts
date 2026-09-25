// @signet/contracts — the spine.
// Every cross-boundary shape is defined here as a zod schema first;
// TypeScript types are inferred from the schemas, never written twice.

export * from "./ids.js";
export * from "./errors.js";
export * from "./states.js";
export * from "./adapter.js";
export * from "./context-pack.js";
export * from "./config.js";
export * from "./api.js";
export * from "./effects.js";

export const CONTRACTS_VERSION = "0.0.1" as const;
