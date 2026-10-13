import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./index.css";

// Safeguard require and global for legacy Ketcher dependencies
if (typeof window !== "undefined") {
  window.global = window;
  if (typeof window.require !== "function") {
    window.require = function (id) {
      if (id === "raphael") return window.Raphael;
      return {};
    };
  }
}

const root = createRoot(document.getElementById("root"));
root.render(
  <BrowserRouter>
    <App />
  </BrowserRouter>
);