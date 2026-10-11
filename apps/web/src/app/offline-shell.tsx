"use client";

import { useEffect, useState } from "react";

/**
 * Installs the offline service worker from any page, so one visit to the site while online is
 * enough for the Wallet and Pay offline pages to open later with no signal.
 */
export function OfflineShell() {
  useEffect(() => {
    if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
    // updateViaCache "none": the browser always asks the server for a newer worker.
    navigator.serviceWorker
      .register("/offline-sw.js", { scope: "/", updateViaCache: "none" })
      .catch(() => undefined);
  }, []);
  return null;
}

/** Whether the saved offline copy of the app is installed and in control on this device. */
export function useOfflineReady(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
    let active = true;
    navigator.serviceWorker.ready
      .then(() => {
        if (active) setReady(true);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  return ready;
}

/** The browser's own connectivity flag, kept current; true until the page has hydrated. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return online;
}
