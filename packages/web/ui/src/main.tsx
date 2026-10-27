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
import "./styles.css";
import { applyTheme, readThemePref } from "./lib/theme.js";

applyTheme(readThemePref());

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
    <Toaster />
  </React.StrictMode>,
);
