"use client";

import { useEffect } from "react";

// Registers the PWA service worker (/sw.js) once, after the window has loaded.
// No-op on the server and where service workers are unavailable. The SW uses a
// network-first strategy for navigations, so fresh deploys aren't stuck behind
// a stale cache.
export function SwRegister() {
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;

    const register = () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        // Registration failures are non-fatal for the app.
      });
    };

    if (document.readyState === "complete") {
      register();
    } else {
      window.addEventListener("load", register, { once: true });
      return () => window.removeEventListener("load", register);
    }
  }, []);

  return null;
}
