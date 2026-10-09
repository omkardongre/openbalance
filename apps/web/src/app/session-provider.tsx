"use client";

import { createContext, type ReactNode, useContext, useMemo, useState } from "react";

export type AccountSession = {
  account: string;
  sessionToken: string;
  /** The passkey that signed in; it also signs reserve commands for this session. */
  credentialId: string;
};

type SessionContext = {
  session: AccountSession | undefined;
  signedIn: (session: AccountSession) => void;
  signedOut: () => void;
};

const Context = createContext<SessionContext | undefined>(undefined);

/**
 * Keeps the signed-in session for the life of the tab, so moving between the wallet and the
 * offline pages does not ask for the passkey again. It lives in memory only: the bearer token is
 * never written to storage, so a reload or a new tab signs in again.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AccountSession>();
  const value = useMemo<SessionContext>(
    () => ({ session, signedIn: setSession, signedOut: () => setSession(undefined) }),
    [session],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useSession() {
  const value = useContext(Context);
  if (!value) throw new Error("useSession must be used inside SessionProvider");
  return value;
}
