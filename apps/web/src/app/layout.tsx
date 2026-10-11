import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";
import { OfflineShell } from "./offline-shell";
import { SessionProvider } from "./session-provider";

export const metadata: Metadata = {
  title: "OpenBalance",
  description: "Exact event payments with attendee-controlled outage reserves.",
  manifest: "/manifest.webmanifest",
  icons: { icon: "/openbalance-icon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <OfflineShell />
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  );
}
