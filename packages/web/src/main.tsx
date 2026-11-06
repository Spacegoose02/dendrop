import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { loadAppearance, setAppearance } from "@dendrop/theme";
import "@dendrop/theme/tokens.css";
import "./styles.css";
import { App } from "./App.tsx";

// Apply the saved theme and icon before the first render so there is no flash of the default.
setAppearance(loadAppearance());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
