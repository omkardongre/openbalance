"use client";

import { accountFactoryAbi } from "@openbalance/protocol";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { useState } from "react";
import {
  type Address,
  encodeFunctionData,
  type Hex,
  sha256,
  stringToHex,
  zeroAddress,
  zeroHash,
} from "viem";

type Enrollment = { publicKey: { x: Hex; y: Hex }; rpId: string; origin: string };
type Deployment = {
  account: Address;
  status: "pending" | "confirmed";
  transaction: { to: Address; data: Hex; value: "0x0"; chainId: Hex };
  parameters: { salt: Hex };
  manifest: { chainId: number; factory: Address };
};
async function post(path: string, body: unknown) {
  const api = process.env.NEXT_PUBLIC_API_URL;
  if (!api) throw new Error("Enrollment service is not configured.");
  const response = await fetch(`${api}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok)
    throw new Error(
      response.status === 503
        ? "Service unavailable. Retry checking the same account."
        : "The request could not be verified. Your existing account has not been changed.",
    );
  return response.json();
}

export default function EnrollPage() {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [record, setRecord] = useState<string>();
  const [token, setToken] = useState<string>();
  const [verifiedKey, setVerifiedKey] = useState<Enrollment>();
  const [deployment, setDeployment] = useState<Deployment>();
  const [submitted, setSubmitted] = useState(false);
  async function enroll() {
    setBusy(true);
    setRecord(undefined);
    setToken(undefined);
    setVerifiedKey(undefined);
    setDeployment(undefined);
    setSubmitted(false);
    setStatus("Create your passkey, then confirm it.");
    try {
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
      setToken(start.token);
      setVerifiedKey(verified);
      setStatus(
        "Passkey verified. Account deployment is the next step; no account has been funded.",
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Enrollment failed.");
    } finally {
      setBusy(false);
    }
  }
  async function deploy(submit: boolean) {
    if (!token || !verifiedKey) return;
    setBusy(true);
    try {
      const result: Deployment = await post("/v1/accounts/deployments/prepare", { token });
      const owners = {
        primary: verifiedKey.publicKey,
        backup: { x: zeroHash, y: zeroHash },
        recovery: zeroAddress,
      };
      const expected = encodeFunctionData({
        abi: accountFactoryAbi,
        functionName: "create",
        args: [
          owners,
          sha256(stringToHex(verifiedKey.rpId)),
          verifiedKey.origin,
          result.parameters.salt,
        ],
      });
      if (
        ![31337, 10143].includes(result.manifest.chainId) ||
        result.transaction.chainId !== `0x${result.manifest.chainId.toString(16)}` ||
        result.transaction.to !== result.manifest.factory ||
        result.transaction.value !== "0x0" ||
        expected !== result.transaction.data ||
        verifiedKey.origin !== window.location.origin
      )
        throw new Error("Deployment parameters do not match your verified passkey.");
      setDeployment(result);
      if (result.status === "confirmed") {
        setStatus("Account verified onchain. Set up recovery before adding funds.");
        return;
      }
      if (submit) {
        const provider = (
          window as unknown as {
            ethereum?: { request(input: { method: string; params?: unknown[] }): Promise<unknown> };
          }
        ).ethereum;
        if (!provider)
          throw new Error("A connected test wallet is required to pay the deployment network fee.");
        const addresses = await provider.request({ method: "eth_requestAccounts" });
        if (!Array.isArray(addresses) || !/^0x[0-9a-fA-F]{40}$/.test(addresses[0]))
          throw new Error("No wallet account available.");
        if ((await provider.request({ method: "eth_chainId" })) !== result.transaction.chainId)
          throw new Error(`Switch your test wallet to chain ${result.manifest.chainId}.`);
        setSubmitted(true);
        await provider.request({
          method: "eth_sendTransaction",
          params: [{ ...result.transaction, from: addresses[0] }],
        });
      }
      const observation: Deployment = await post("/v1/accounts/deployments/confirm", { token });
      setDeployment(observation);
      setStatus(
        observation.status === "confirmed"
          ? "Account verified onchain. Set up recovery before adding funds."
          : "Waiting for finalized account state. Use Check account to refresh.",
      );
    } catch (error) {
      setStatus(
        error instanceof Error
          ? error.message
          : "Deployment could not be verified. Check the same account before retrying.",
      );
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
        {token && (
          <section aria-label="Account deployment">
            <p>
              Test deployment: a helper wallet pays the network fee. Your passkey owns the account.
              Backup and recovery are not enrolled yet.
            </p>
            <button
              type="button"
              disabled={busy || submitted || deployment?.status === "confirmed"}
              onClick={() => deploy(true)}
            >
              Deploy test account
            </button>
            <button type="button" disabled={busy} onClick={() => deploy(false)}>
              Check account
            </button>
            {submitted && deployment?.status !== "confirmed" && (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setSubmitted(false);
                  setStatus(
                    "Retry uses the same account and may incur another network fee. Check your wallet activity first.",
                  );
                }}
              >
                Enable retry for the same account
              </button>
            )}
            {deployment && <p>Account: {deployment.account}</p>}
          </section>
        )}
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
