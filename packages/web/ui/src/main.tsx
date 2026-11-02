import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { Toaster } from "@/ui/sonner";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./index.css";
import { legacyHashTarget } from "./lib/location.js";
import { applyTheme, readThemePref } from "./lib/theme.js";

// Pin the server's relative <base> to an absolute one, so pushState to another depth cannot move
// it, then replace an old #/... link with its path once.
document.querySelector("base")?.setAttribute("href", document.baseURI);
const legacy = legacyHashTarget(location.hash);
if (legacy !== null) history.replaceState(null, "", legacy);

applyTheme(readThemePref());

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
    <Toaster />
  </React.StrictMode>,
);
