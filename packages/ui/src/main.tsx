import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./app/App.js";
import { RealtimeProvider } from "./realtime.js";
import "./signet.css";

const qc = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 2000,
      // The socket is the primary freshness signal; focus does not need a second wave.
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("root element missing");
createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <RealtimeProvider>
        <App />
      </RealtimeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
