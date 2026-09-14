"use client";

import {
  createVerificationReader,
  type DeploymentManifest,
  VerificationFailed,
  verifyCustodyConservation,
  verifyDeployment,
  verifyFinalizedChannel,
  verifyFinalizedTransition,
} from "@openbalance/verifier";
import { useState } from "react";
import { type Address, type Chain, getAddress, type Hex } from "viem";

const bytes32 = /^0x[0-9a-fA-F]{64}$/;
const address = /^0x[0-9a-fA-F]{40}$/;

function deploymentManifest(value: string): DeploymentManifest {
  const parsed = JSON.parse(value) as Record<string, unknown>;
  if (
    !Number.isSafeInteger(parsed.chainId) ||
    Number(parsed.chainId) < 1 ||
    !bytes32.test(String(parsed.eventId)) ||
    !address.test(String(parsed.asset))
  )
    throw new VerificationFailed("Deployment manifest identity is invalid");
  const contract = (name: "registry" | "ledger" | "router" | "vault") => {
    const item = parsed[name] as Record<string, unknown> | undefined;
    if (!item || !address.test(String(item.address)) || !bytes32.test(String(item.runtimeCodeHash)))
      throw new VerificationFailed(`${name} manifest is invalid`);
    return {
      address: getAddress(String(item.address)),
      runtimeCodeHash: String(item.runtimeCodeHash).toLowerCase() as Hex,
    };
  };
  return {
    chainId: Number(parsed.chainId),
    eventId: String(parsed.eventId).toLowerCase() as Hex,
    asset: getAddress(String(parsed.asset)),
    registry: contract("registry"),
    ledger: contract("ledger"),
    router: contract("router"),
    vault: contract("vault"),
  };
}

function chainFor(manifest: DeploymentManifest, rpcUrl: string): Chain {
  return {
    id: manifest.chainId,
    name: `Chain ${manifest.chainId}`,
    nativeCurrency: { name: "Native gas token", symbol: "GAS", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  };
}

function printable(value: unknown) {
  return JSON.stringify(
    value,
    (_key, item) => (typeof item === "bigint" ? item.toString() : item),
    2,
  );
}

export default function VerifyPage() {
  const [rpcUrl, setRpcUrl] = useState("");
  const [manifestJson, setManifestJson] = useState("");
  const [channelId, setChannelId] = useState("");
  const [transactionHash, setTransactionHash] = useState("");
  const [paymentId, setPaymentId] = useState("");
  const [payer, setPayer] = useState("");
  const [vendorId, setVendorId] = useState("");
  const [grossUnits, setGrossUnits] = useState("");
  const [result, setResult] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  function reader() {
    const manifest = deploymentManifest(manifestJson);
    return {
      manifest,
      reader: createVerificationReader(rpcUrl, chainFor(manifest, rpcUrl)),
    };
  }

  async function run(label: string, operation: () => Promise<unknown>) {
    setBusy(true);
    setResult("");
    setStatus(`Verifying ${label} directly from finalized chain state…`);
    try {
      const proof = await operation();
      setResult(printable(proof));
      setStatus(`${label} verified independently.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : `${label} verification failed.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <div className="page-stack verifier-stack">
        <section className="shell verifier-shell">
          <p className="eyebrow">Independent verifier</p>
          <h1>Trust chain state, not our database.</h1>
          <p className="summary">
            Supply a public RPC and published deployment manifest. Verification runs in this browser
            against canonical finalized state; no OpenBalance API credential is used.
          </p>
          <label>
            Public RPC URL
            <input
              type="url"
              value={rpcUrl}
              disabled={busy}
              onChange={(event) => setRpcUrl(event.target.value)}
            />
          </label>
          <label>
            Deployment manifest
            <textarea
              value={manifestJson}
              disabled={busy}
              spellCheck={false}
              placeholder='{"chainId":10143,"eventId":"0x…"}'
              onChange={(event) => setManifestJson(event.target.value)}
            />
          </label>
          <div className="actions">
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                run("deployment", async () => {
                  const input = reader();
                  return verifyDeployment(input.reader, input.manifest);
                })
              }
            >
              Verify deployment
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() =>
                run("custody conservation", async () => {
                  const input = reader();
                  await verifyDeployment(input.reader, input.manifest);
                  return verifyCustodyConservation(input.reader, input.manifest);
                })
              }
            >
              Verify custody
            </button>
          </div>
          <p role="status">{status}</p>
        </section>

        <section className="shell operations-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Reserve proof</p>
              <h2>Inspect a finalized channel</h2>
            </div>
            <p>Exact policy and recipients</p>
          </div>
          <label>
            Channel ID
            <input
              value={channelId}
              disabled={busy}
              spellCheck={false}
              onChange={(event) => setChannelId(event.target.value)}
            />
          </label>
          <button
            type="button"
            disabled={busy || !bytes32.test(channelId)}
            onClick={() =>
              run("reserve channel", async () => {
                const input = reader();
                return verifyFinalizedChannel(input.reader, input.manifest, channelId as Hex);
              })
            }
          >
            Verify untouched channel
          </button>
        </section>

        <section className="shell operations-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Payment proof</p>
              <h2>Match a finalized receipt</h2>
            </div>
            <p>Exact event fields</p>
          </div>
          <div className="configuration-fields">
            <label>
              Transaction hash
              <input
                value={transactionHash}
                disabled={busy}
                onChange={(event) => setTransactionHash(event.target.value)}
              />
            </label>
            <label>
              Payment ID
              <input
                value={paymentId}
                disabled={busy}
                onChange={(event) => setPaymentId(event.target.value)}
              />
            </label>
            <label>
              Payer account
              <input
                value={payer}
                disabled={busy}
                onChange={(event) => setPayer(event.target.value)}
              />
            </label>
            <label>
              Vendor ID
              <input
                value={vendorId}
                disabled={busy}
                onChange={(event) => setVendorId(event.target.value)}
              />
            </label>
            <label>
              Gross base units
              <input
                inputMode="numeric"
                value={grossUnits}
                disabled={busy}
                onChange={(event) => setGrossUnits(event.target.value)}
              />
            </label>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              run("payment receipt", async () => {
                const input = reader();
                if (
                  !bytes32.test(transactionHash) ||
                  !bytes32.test(paymentId) ||
                  !address.test(payer) ||
                  !bytes32.test(vendorId) ||
                  !/^[1-9][0-9]*$/.test(grossUnits)
                )
                  throw new VerificationFailed("Payment proof fields are invalid");
                return verifyFinalizedTransition(input.reader, {
                  kind: "payment",
                  contract: input.manifest.router.address,
                  transactionHash: transactionHash as Hex,
                  paymentId: paymentId as Hex,
                  payer: getAddress(payer) as Address,
                  vendorId: vendorId as Hex,
                  gross: BigInt(grossUnits),
                });
              })
            }
          >
            Verify finalized payment
          </button>
        </section>

        {result && (
          <section className="shell verifier-result">
            <p className="eyebrow">Verified proof</p>
            <pre>{result}</pre>
          </section>
        )}
      </div>
    </main>
  );
}
