"use client";

import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { useState } from "react";

export default function EnrollPage() {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [record, setRecord] = useState<string>();
  async function enroll() {
    setBusy(true);
    setRecord(undefined);
    setStatus("Create your passkey, then confirm it.");
    try {
      const api = process.env.NEXT_PUBLIC_API_URL;
      if (!api) throw new Error("Enrollment service is not configured.");
      async function post(path: string, body: unknown) {
        const response = await fetch(`${api}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          cache: "no-store",
        });
        if (!response.ok) throw new Error("Enrollment could not be verified. Please start again.");
        return response.json();
      }
      const start = await post("/v1/accounts/enrollment-challenges", {});
      const registered = await startRegistration({ optionsJSON: start.options });
      const proof = await post("/v1/accounts/enrollments/register", {
        token: start.token,
        response: registered,
      });
      const signed = await startAuthentication({ optionsJSON: proof.options });
      const verified = await post("/v1/accounts/enrollments/prove", {
        token: start.token,
        response: signed,
      });
      if (verified.status !== "verified") throw new Error("Passkey verification incomplete.");
      setRecord(JSON.stringify(verified, null, 2));
      setStatus(
        "Passkey verified. Account deployment is the next step; no account has been funded.",
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Enrollment failed.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main>
      <section className="shell">
        <h1>Create your passkey</h1>
        <p>Your device protects the key. Confirm it twice to verify that it works.</p>
        <button type="button" disabled={busy} onClick={enroll}>
          {busy ? "Verifying…" : "Create passkey"}
        </button>
        <p role="status">{status}</p>
        {record && (
          <details>
            <summary>Public enrollment record</summary>
            <pre>{record}</pre>
          </details>
        )}
      </section>
    </main>
  );
}
