"use client";

import { useState } from "react";
import { createWalletClient, custom, getAddress, type Hex } from "viem";

type Profile = {
  role: "VENDOR" | "ORGANIZER" | "FINANCE" | "SUPPORT";
  eventId: Hex;
  organizerPolicy: {
    chainId: number;
    registry: `0x${string}`;
  } | null;
};

type PreparedOperation = {
  operationId: string;
  state: "PREPARED" | "FINALIZED";
  transactionHash: Hex | null;
  transaction: {
    from: `0x${string}`;
    to: `0x${string}`;
    data: Hex;
    value: "0x0";
    chainId: Hex;
  };
  statusUrl: string;
  confirmation?: "PENDING";
};

type Props = {
  api: string;
  token: string;
  profile: Profile;
  busy: boolean;
  setBusy(value: boolean): void;
  setStatus(value: string): void;
};

const bytes32 = /^0x[0-9a-fA-F]{64}$/;
const address = /^0x[0-9a-fA-F]{40}$/;
const positive = /^[1-9][0-9]*$/;

async function stableKey(prefix: string, value: unknown) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return `${prefix}-${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function unixSeconds(value: string): string {
  const timestamp = new Date(`${value}Z`).getTime();
  if (!Number.isFinite(timestamp) || timestamp <= 0) throw new Error("Enter a valid UTC window.");
  return Math.floor(timestamp / 1_000).toString();
}

function provider() {
  const ethereum = (
    window as unknown as {
      ethereum?: { request(input: { method: string; params?: unknown[] }): Promise<unknown> };
    }
  ).ethereum;
  if (!ethereum) throw new Error("Connect the required wallet.");
  return ethereum;
}

export function OrganizerConfigurationPanel({
  api,
  token,
  profile,
  busy,
  setBusy,
  setStatus,
}: Props) {
  const [kind, setKind] = useState<"CONFIG" | "VENDOR" | "DESTINATION" | "TERMINAL">("TERMINAL");
  const [vendorId, setVendorId] = useState("");
  const [authority, setAuthority] = useState("");
  const [destination, setDestination] = useState("");
  const [destinationVersion, setDestinationVersion] = useState("1");
  const [destinationDeadline, setDestinationDeadline] = useState("");
  const [vendorSignature, setVendorSignature] = useState<Hex>();
  const [terminalId, setTerminalId] = useState("");
  const [terminalVersion, setTerminalVersion] = useState("1");
  const [terminalSigner, setTerminalSigner] = useState("");
  const [terminalValidAfter, setTerminalValidAfter] = useState("");
  const [terminalValidUntil, setTerminalValidUntil] = useState("");
  const [configVersion, setConfigVersion] = useState("1");
  const [configValidAfter, setConfigValidAfter] = useState("");
  const [configValidUntil, setConfigValidUntil] = useState("");
  const [organizerFeeBps, setOrganizerFeeBps] = useState("0");
  const [platformFeeBps, setPlatformFeeBps] = useState("0");
  const [acceptanceSeconds, setAcceptanceSeconds] = useState("3600");
  const [submissionSeconds, setSubmissionSeconds] = useState("3600");
  const [organizerDestination, setOrganizerDestination] = useState("");
  const [platformDestination, setPlatformDestination] = useState("");
  const [termsHash, setTermsHash] = useState("");
  const [operation, setOperation] = useState<PreparedOperation>();

  async function request(path: string, init: RequestInit): Promise<PreparedOperation> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    const response = await fetch(`${api}${path}`, {
      ...init,
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error?.replaceAll("_", " ") ?? "Configuration request failed.");
    }
    return response.json() as Promise<PreparedOperation>;
  }

  function payload(): Record<string, unknown> {
    if (kind === "VENDOR") {
      if (!bytes32.test(vendorId) || !address.test(authority))
        throw new Error("Enter the vendor identifier and authority address.");
      return { kind, vendorId, authority };
    }
    if (kind === "DESTINATION") {
      if (
        !bytes32.test(vendorId) ||
        !address.test(destination) ||
        !positive.test(destinationVersion) ||
        !positive.test(destinationDeadline) ||
        !vendorSignature
      )
        throw new Error("Complete and sign the vendor destination approval first.");
      return {
        kind,
        vendorId,
        version: destinationVersion,
        destination,
        deadline: destinationDeadline,
        vendorSignature,
      };
    }
    if (kind === "TERMINAL") {
      if (
        !bytes32.test(terminalId) ||
        !bytes32.test(vendorId) ||
        !address.test(terminalSigner) ||
        !positive.test(terminalVersion)
      )
        throw new Error("Complete the terminal identity, version, vendor, and signer.");
      return {
        kind,
        terminalId,
        version: terminalVersion,
        vendorId,
        signer: terminalSigner,
        validAfter: unixSeconds(terminalValidAfter),
        validUntil: unixSeconds(terminalValidUntil),
      };
    }
    if (
      !positive.test(configVersion) ||
      !/^\d+$/.test(organizerFeeBps) ||
      !/^\d+$/.test(platformFeeBps) ||
      !positive.test(acceptanceSeconds) ||
      !positive.test(submissionSeconds) ||
      !address.test(organizerDestination) ||
      !address.test(platformDestination) ||
      !bytes32.test(termsHash)
    )
      throw new Error("Complete the immutable configuration fields.");
    return {
      kind,
      version: configVersion,
      validAfter: unixSeconds(configValidAfter),
      validUntil: unixSeconds(configValidUntil),
      organizerFeeBps: Number(organizerFeeBps),
      platformFeeBps: Number(platformFeeBps),
      maximumAcceptanceDuration: acceptanceSeconds,
      maximumSubmissionDelay: submissionSeconds,
      organizerDestination,
      platformDestination,
      termsHash,
      enabled: true,
    };
  }

  async function signDestination() {
    if (!profile.organizerPolicy) return;
    setBusy(true);
    try {
      if (
        !bytes32.test(vendorId) ||
        !address.test(destination) ||
        !positive.test(destinationVersion)
      )
        throw new Error("Enter a vendor, destination, and version.");
      const deadline = BigInt(Math.floor(Date.now() / 1_000) + 900);
      const ethereum = provider();
      const wallet = createWalletClient({ transport: custom(ethereum) });
      const [account] = await wallet.requestAddresses();
      if (!account) throw new Error("Vendor authority wallet is unavailable.");
      const signature = await wallet.signTypedData({
        account,
        domain: {
          name: "OpenBalanceEventRegistry",
          version: "1",
          chainId: profile.organizerPolicy.chainId,
          verifyingContract: getAddress(profile.organizerPolicy.registry),
        },
        types: {
          DestinationApproval: [
            { name: "vendorId", type: "bytes32" },
            { name: "version", type: "uint256" },
            { name: "destination", type: "address" },
            { name: "deadline", type: "uint256" },
          ],
        },
        primaryType: "DestinationApproval",
        message: {
          vendorId: vendorId as Hex,
          version: BigInt(destinationVersion),
          destination: getAddress(destination),
          deadline,
        },
      });
      setDestinationDeadline(deadline.toString());
      setVendorSignature(signature);
      setStatus("Vendor destination approved. Switch to the organizer wallet to register it.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Destination approval failed.");
    } finally {
      setBusy(false);
    }
  }

  async function prepareAndSend() {
    setBusy(true);
    try {
      const body = payload();
      const key = await stableKey(`configuration-${kind.toLowerCase()}`, body);
      const encodedEvent = encodeURIComponent(profile.eventId);
      const prepared = await request(`/v1/events/${encodedEvent}/configuration-operations`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify(body),
      });
      const ethereum = provider();
      const [accounts, currentChain] = (await Promise.all([
        ethereum.request({ method: "eth_requestAccounts" }),
        ethereum.request({ method: "eth_chainId" }),
      ])) as [string[], string];
      if (!accounts[0] || getAddress(accounts[0]) !== getAddress(prepared.transaction.from))
        throw new Error("Connect the registry organizer wallet.");
      if (currentChain.toLowerCase() !== prepared.transaction.chainId.toLowerCase())
        throw new Error("Switch the organizer wallet to the configured network.");
      const transactionHash = (await ethereum.request({
        method: "eth_sendTransaction",
        params: [prepared.transaction],
      })) as Hex;
      const pending = await request(`${prepared.statusUrl}/confirmations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transactionHash }),
      });
      setOperation({ ...pending, transactionHash });
      setStatus(
        pending.state === "FINALIZED"
          ? "Registry change is finalized."
          : "Transaction submitted; finalized registry read-back is pending.",
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Configuration submission failed.");
    } finally {
      setBusy(false);
    }
  }

  async function checkFinality() {
    if (!operation?.transactionHash) return;
    setBusy(true);
    try {
      const checked = await request(`${operation.statusUrl}/confirmations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transactionHash: operation.transactionHash }),
      });
      setOperation(checked);
      setStatus(
        checked.state === "FINALIZED"
          ? "Registry change is finalized."
          : "Canonical finality is still pending.",
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Finality check failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="shell operations-panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Organizer authority</p>
          <h2>Register immutable event policy</h2>
        </div>
        <p>Prepared by API · signed by organizer wallet</p>
      </div>
      <label>
        Action
        <select
          value={kind}
          disabled={busy}
          onChange={(event) => setKind(event.target.value as typeof kind)}
        >
          <option value="CONFIG">Configuration version</option>
          <option value="VENDOR">Vendor authority</option>
          <option value="DESTINATION">Vendor payout destination</option>
          <option value="TERMINAL">Terminal key enrollment</option>
        </select>
      </label>

      {kind === "CONFIG" && (
        <div className="configuration-fields">
          <label>
            Version
            <input
              inputMode="numeric"
              value={configVersion}
              onChange={(event) => setConfigVersion(event.target.value)}
            />
          </label>
          <label>
            Valid after (UTC)
            <input
              type="datetime-local"
              value={configValidAfter}
              onChange={(event) => setConfigValidAfter(event.target.value)}
            />
          </label>
          <label>
            Valid until (UTC)
            <input
              type="datetime-local"
              value={configValidUntil}
              onChange={(event) => setConfigValidUntil(event.target.value)}
            />
          </label>
          <label>
            Organizer fee (bps)
            <input
              inputMode="numeric"
              value={organizerFeeBps}
              onChange={(event) => setOrganizerFeeBps(event.target.value)}
            />
          </label>
          <label>
            Platform fee (bps)
            <input
              inputMode="numeric"
              value={platformFeeBps}
              onChange={(event) => setPlatformFeeBps(event.target.value)}
            />
          </label>
          <label>
            Maximum acceptance seconds
            <input
              inputMode="numeric"
              value={acceptanceSeconds}
              onChange={(event) => setAcceptanceSeconds(event.target.value)}
            />
          </label>
          <label>
            Maximum submission delay
            <input
              inputMode="numeric"
              value={submissionSeconds}
              onChange={(event) => setSubmissionSeconds(event.target.value)}
            />
          </label>
          <label>
            Organizer destination
            <input
              value={organizerDestination}
              onChange={(event) => setOrganizerDestination(event.target.value)}
            />
          </label>
          <label>
            Platform destination
            <input
              value={platformDestination}
              onChange={(event) => setPlatformDestination(event.target.value)}
            />
          </label>
          <label>
            Canonical terms hash
            <input value={termsHash} onChange={(event) => setTermsHash(event.target.value)} />
          </label>
        </div>
      )}

      {(kind === "VENDOR" || kind === "DESTINATION" || kind === "TERMINAL") && (
        <label>
          Vendor identifier
          <input value={vendorId} onChange={(event) => setVendorId(event.target.value)} />
        </label>
      )}
      {kind === "VENDOR" && (
        <label>
          Vendor authority wallet
          <input value={authority} onChange={(event) => setAuthority(event.target.value)} />
        </label>
      )}
      {kind === "DESTINATION" && (
        <div className="configuration-fields">
          <label>
            Destination version
            <input
              inputMode="numeric"
              value={destinationVersion}
              onChange={(event) => {
                setDestinationVersion(event.target.value);
                setVendorSignature(undefined);
              }}
            />
          </label>
          <label>
            Payout destination
            <input
              value={destination}
              onChange={(event) => {
                setDestination(event.target.value);
                setVendorSignature(undefined);
              }}
            />
          </label>
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={signDestination}
          >
            Sign as vendor authority
          </button>
        </div>
      )}
      {kind === "TERMINAL" && (
        <div className="configuration-fields">
          <label>
            Terminal instance ID
            <input value={terminalId} onChange={(event) => setTerminalId(event.target.value)} />
          </label>
          <label>
            Key version
            <input
              inputMode="numeric"
              value={terminalVersion}
              onChange={(event) => setTerminalVersion(event.target.value)}
            />
          </label>
          <label>
            Protected-key signer
            <input
              value={terminalSigner}
              onChange={(event) => setTerminalSigner(event.target.value)}
            />
          </label>
          <label>
            Valid after (UTC)
            <input
              type="datetime-local"
              value={terminalValidAfter}
              onChange={(event) => setTerminalValidAfter(event.target.value)}
            />
          </label>
          <label>
            Valid until (UTC)
            <input
              type="datetime-local"
              value={terminalValidUntil}
              onChange={(event) => setTerminalValidUntil(event.target.value)}
            />
          </label>
        </div>
      )}
      <button type="button" disabled={busy} onClick={prepareAndSend}>
        Prepare and send with organizer wallet
      </button>
      {operation?.transactionHash && operation.state !== "FINALIZED" && (
        <button type="button" className="secondary-button" disabled={busy} onClick={checkFinality}>
          Check finalized read-back
        </button>
      )}
      {operation && (
        <p role="status">
          Operation {operation.operationId.slice(0, 8)}: {operation.state.toLowerCase()}
        </p>
      )}
    </section>
  );
}
