"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useOnline } from "./offline-shell";

function WalletIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <rect x="3" y="6" width="18" height="14" rx="3" />
      <path d="M3 10h18M16 15h2" strokeLinecap="round" />
    </svg>
  );
}

function ScanIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path
        d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M7 12h10"
        strokeLinecap="round"
      />
    </svg>
  );
}

const TABS = [
  { href: "/account", label: "Wallet", Icon: WalletIcon },
  { href: "/offline", label: "Pay offline", Icon: ScanIcon },
] as const;

/** The attendee's two destinations, as a bottom tab bar on phones and a top bar on wider screens. */
export function AttendeeNav() {
  const path = usePathname();
  // Offline, a client-side switch would need the server; a full page load is answered by the
  // saved offline copy instead.
  const Tab = useOnline() ? Link : "a";
  return (
    <nav className="tabbar" aria-label="Attendee">
      {TABS.map(({ href, label, Icon }) => (
        <Tab key={href} href={href} aria-current={path === href ? "page" : undefined}>
          <Icon />
          <span>{label}</span>
        </Tab>
      ))}
    </nav>
  );
}
