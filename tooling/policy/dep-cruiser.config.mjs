// Signet layering rules for apps/core. One-way only:
//   http → services → domain → persistence(interfaces)
// Domain modules: pipeline, runtime, adapter, gates, learner, memory.
// The adapter returns typed events; it never touches persistence.
// Persistence implementations are reached only through domain interfaces.

/** @type {import('dependency-cruiser').IConfiguration} */
export default {
  forbidden: [
    {
      name: "domain-not-to-http",
      severity: "error",
      comment: "domain must not know the transport layer",
      from: { path: "^apps/core/src/domain" },
      to: { path: "^apps/core/src/http" },
    },
    {
      name: "domain-not-to-services",
      severity: "error",
      comment: "dependencies flow services → domain, never back",
      from: { path: "^apps/core/src/domain" },
      to: { path: "^apps/core/src/services" },
    },
    {
      name: "persistence-not-upward",
      severity: "error",
      comment: "persistence implements domain interfaces; it imports domain types only",
      from: { path: "^apps/core/src/persistence" },
      to: { path: "^apps/core/src/(http|services)" },
    },
    {
      name: "adapter-not-to-persistence",
      severity: "error",
      comment: "the adapter returns typed events; the runtime persists them",
      from: { path: "^apps/core/src/domain/adapter" },
      to: { path: "^apps/core/src/persistence" },
    },
    {
      name: "http-not-to-persistence",
      severity: "error",
      comment: "http reaches data only through services → domain",
      from: { path: "^apps/core/src/http" },
      to: { path: "^apps/core/src/persistence" },
    },
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsConfig: { fileName: "apps/core/tsconfig.json" },
  },
};
