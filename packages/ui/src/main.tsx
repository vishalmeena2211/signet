import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App.js";
import { RealtimeProvider } from "./realtime.js";
import { ToastHost } from "./ui/feedback.js";
import "./tokens.css";

const qc = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 2000,
      // The WebSocket is the primary freshness signal, so window focus does not
      // need to trigger a second wave of refetches.
      refetchOnWindowFocus: false,
      // One retry: a transient blip is worth retrying, a down server is not worth
      // hammering — and QueryState explains the failure either way.
      retry: 1,
    },
  },
});

// Theme and density are applied before first paint, so the console never flashes
// the wrong theme on load.
document.documentElement.dataset.theme = localStorage.getItem("signet.theme") ?? "dark";
document.documentElement.dataset.density = localStorage.getItem("signet.density") ?? "comfortable";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("root element missing");
createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      {/* Toasts wrap realtime: the realtime client reports reconnects through them. */}
      <ToastHost>
        <RealtimeProvider>
          <App />
        </RealtimeProvider>
      </ToastHost>
    </QueryClientProvider>
  </StrictMode>,
);
