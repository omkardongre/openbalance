"use client";

import { useState } from "react";

const bytes32 = /^0x[0-9a-fA-F]{64}$/;

type Statement = {
  vendorId: string;
  totals: {
    paymentCount: number;
    grossUnits: string;
    refundedUnits: string;
    withdrawnUnits: string;
    availableAllocationUnits: string | null;
    readbackRequiredGrossUnits: string;
    allocationStatus: "COMPLETE" | "READBACK_REQUIRED" | "PERIOD_ONLY";
  };
  finalizedThrough: { blockNumber: string; blockHash: string; indexedAt: string };
  payments: Array<{
    paymentId: string;
    mode: string;
    grossUnits: string;
    allocationStatus: string;
    proof: { transactionHash: string; blockNumber: string };
  }>;
};

type Reconciliation = {
  status: "MATCHED" | "DIFFERENT" | "STALE" | "NOT_RUN";
  finalizedThrough: { blockNumber: string; blockHash: string; indexedAt: string };
  differences: Array<{ metric: string; expectedUnits: string; actualUnits: string }>;
  pendingAllocationReadback: { paymentCount: number; grossUnits: string };
  openIntegrityIncidents: Array<{
    incidentId: string;
    code: string;
    severity: string;
    message: string;
  }>;
};

type Incident = {
  incidentId: string;
  severity: string;
  summary: string;
  owner: string;
  status: string;
  mitigation: string;
  nextAction: string;
};

type OperationsProfile = {
  role: "VENDOR" | "ORGANIZER" | "FINANCE" | "SUPPORT";
  eventId: string;
  vendorId: string | null;
};

function short(value: string) {
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

async function idempotencyKey(prefix: string, value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `${prefix}-${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export default function OperationsPage() {
  const [token, setToken] = useState("");
  const [eventId, setEventId] = useState("");
  const [vendorId, setVendorId] = useState("");
  const [statement, setStatement] = useState<Statement>();
  const [reconciliation, setReconciliation] = useState<Reconciliation>();
  const [incidents, setIncidents] = useState<Incident[]>();
  const [profile, setProfile] = useState<OperationsProfile>();
  const [severity, setSeverity] = useState("MEDIUM");
  const [summary, setSummary] = useState("");
  const [mitigation, setMitigation] = useState("");
  const [nextAction, setNextAction] = useState("");
  const [owner, setOwner] = useState("");
  const [resolutionProofs, setResolutionProofs] = useState<Record<string, string>>({});
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const api = process.env.NEXT_PUBLIC_API_URL;

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!api) throw new Error("Operations service is not configured.");
    if (!token) throw new Error("Enter your scoped operations credential.");
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
      throw new Error(body?.error?.replaceAll("_", " ") ?? "Operations data is unavailable.");
    }
    return response.json() as Promise<T>;
  }

  async function load() {
    if (!token) {
      setStatus("Enter your scoped operations credential.");
      return;
    }
    setBusy(true);
    setStatus("Loading finalized operational records…");
    try {
      const profile = await request<OperationsProfile>("/v1/operations/me");
      setProfile(profile);
      const scopedVendor = profile.role === "VENDOR" ? profile.vendorId : vendorId;
      if (profile.role === "VENDOR" && !bytes32.test(scopedVendor ?? ""))
        throw new Error("Enter the vendor identifier for this statement.");
      setEventId(profile.eventId);
      if (profile.vendorId) setVendorId(profile.vendorId);
      const encodedEvent = encodeURIComponent(profile.eventId);
      const [nextStatement, nextReconciliation, nextIncidents] = await Promise.all([
        scopedVendor &&
        bytes32.test(scopedVendor) &&
        ["VENDOR", "ORGANIZER", "FINANCE"].includes(profile.role)
          ? request<Statement>(
              `/v1/events/${encodedEvent}/statements?vendorId=${encodeURIComponent(scopedVendor)}`,
            )
          : Promise.resolve(undefined),
        ["ORGANIZER", "FINANCE"].includes(profile.role)
          ? request<Reconciliation>(`/v1/events/${encodedEvent}/reconciliation`)
          : Promise.resolve(undefined),
        request<{ items: Incident[] }>(`/v1/events/${encodedEvent}/incidents?status=OPEN&limit=25`),
      ]);
      setStatement(nextStatement);
      setReconciliation(nextReconciliation);
      setIncidents(nextIncidents.items);
      setStatus(`${profile.role.toLowerCase()} scope loaded from finalized records.`);
    } catch (error) {
      setStatement(undefined);
      setReconciliation(undefined);
      setIncidents(undefined);
      setProfile(undefined);
      setStatus(error instanceof Error ? error.message : "Operations data is unavailable.");
    } finally {
      setBusy(false);
    }
  }

  async function submitIncident() {
    if (!profile || !owner || !summary || !mitigation || !nextAction) {
      setStatus("Complete the incident owner, summary, mitigation, and next action.");
      return;
    }
    const payload = {
      eventId: profile.eventId,
      affectedVendorId:
        profile.role === "VENDOR" ? profile.vendorId : bytes32.test(vendorId) ? vendorId : null,
      affectedTerminalId: null,
      severity,
      summary,
      mitigation,
      nextAction,
      evidenceRefs: [],
      owner,
    };
    setBusy(true);
    try {
      const key = await idempotencyKey("incident", payload);
      await request<Incident>("/v1/incidents", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify(payload),
      });
      const encodedEvent = encodeURIComponent(profile.eventId);
      const refreshed = await request<{ items: Incident[] }>(
        `/v1/events/${encodedEvent}/incidents?status=OPEN&limit=25`,
      );
      setIncidents(refreshed.items);
      setSummary("");
      setMitigation("");
      setNextAction("");
      setStatus("Incident recorded with an idempotent audit action.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Incident submission is unavailable.");
    } finally {
      setBusy(false);
    }
  }

  async function resolveIncident(incidentId: string) {
    if (!profile) return;
    const resolutionProof = resolutionProofs[incidentId]?.trim();
    if (!resolutionProof) {
      setStatus("Add resolution proof before resolving the incident.");
      return;
    }
    setBusy(true);
    try {
      const payload = { resolutionProof };
      const key = await idempotencyKey(`resolution-${incidentId}`, payload);
      await request<Incident>(`/v1/incidents/${encodeURIComponent(incidentId)}/resolutions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify(payload),
      });
      setIncidents((current) => current?.filter((incident) => incident.incidentId !== incidentId));
      setStatus("Incident resolved. Financial history remains unchanged.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Incident resolution is unavailable.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <div className="page-stack operations-stack">
        <section className="shell operations-shell">
          <p className="eyebrow">Event operations</p>
          <h1>Know what settled.</h1>
          <p className="summary">
            Review finalized vendor money, reconciliation freshness, pending allocation read-back,
            and open incidents from one event-scoped credential.
          </p>
          <div className="operations-inputs">
            <label>
              Operations credential
              <input
                type="password"
                autoComplete="off"
                value={token}
                disabled={busy}
                onChange={(event) => setToken(event.target.value)}
              />
            </label>
            <label>
              Scoped event
              <input
                autoComplete="off"
                spellCheck={false}
                value={eventId || "Resolved from credential"}
                disabled
              />
            </label>
            <label>
              Vendor identifier
              <input
                autoComplete="off"
                spellCheck={false}
                value={vendorId}
                disabled={busy}
                onChange={(event) => setVendorId(event.target.value)}
              />
            </label>
          </div>
          <button type="button" disabled={busy} onClick={load}>
            {busy ? "Checking…" : "Load finalized operations"}
          </button>
          <p role="status">{status}</p>
        </section>

        {incidents && (
          <>
            {statement && (
              <section className="operations-grid" aria-label="Operational totals">
                <article>
                  <span>Finalized gross</span>
                  <strong>{statement.totals.grossUnits}</strong>
                  <small>{statement.totals.paymentCount} payments</small>
                </article>
                <article>
                  <span>Refunded</span>
                  <strong>{statement.totals.refundedUnits}</strong>
                  <small>Original payer only</small>
                </article>
                <article>
                  <span>Withdrawn</span>
                  <strong>{statement.totals.withdrawnUnits}</strong>
                  <small>Fixed destinations</small>
                </article>
                <article>
                  <span>Available allocation</span>
                  <strong>{statement.totals.availableAllocationUnits ?? "Pending"}</strong>
                  <small>{statement.totals.allocationStatus.replaceAll("_", " ")}</small>
                </article>
              </section>
            )}

            {reconciliation && (
              <section className="shell operations-panel">
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">Custody check</p>
                    <h2>Reconciliation: {reconciliation.status}</h2>
                  </div>
                  <p>Finalized block {reconciliation.finalizedThrough.blockNumber}</p>
                </div>
                <p>
                  {reconciliation.pendingAllocationReadback.paymentCount} payments worth{" "}
                  {reconciliation.pendingAllocationReadback.grossUnits} still require allocation
                  read-back.
                </p>
                {reconciliation.differences.length > 0 && (
                  <ul className="warning-list">
                    {reconciliation.differences.map((difference) => (
                      <li key={difference.metric}>
                        {difference.metric}: expected {difference.expectedUnits}, observed{" "}
                        {difference.actualUnits}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}

            {statement && (
              <section className="shell operations-panel">
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">Vendor statement</p>
                    <h2>{short(statement.vendorId)}</h2>
                  </div>
                  <p>{statement.payments.length} lines</p>
                </div>
                {statement.payments.length === 0 ? (
                  <p className="empty-state">No finalized vendor payments in this range.</p>
                ) : (
                  <ol className="activity-list">
                    {statement.payments.map((payment) => (
                      <li key={payment.paymentId}>
                        <div>
                          <strong>{payment.grossUnits} units</strong>
                          <span>
                            {payment.mode.toLowerCase()} · {payment.allocationStatus.toLowerCase()}
                          </span>
                        </div>
                        <div className="proof-ref">
                          <span>Block {payment.proof.blockNumber}</span>
                          <code title={payment.proof.transactionHash}>
                            {short(payment.proof.transactionHash)}
                          </code>
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            )}

            <section className="shell operations-panel">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">Exceptions</p>
                  <h2>Open incidents</h2>
                </div>
                <p>{incidents.length} open</p>
              </div>
              {incidents.length === 0 ? (
                <p className="empty-state">No scoped operational incidents are open.</p>
              ) : (
                <ol className="activity-list">
                  {incidents.map((incident) => (
                    <li key={incident.incidentId}>
                      <div>
                        <strong>{incident.summary}</strong>
                        <span>
                          {incident.owner} · next: {incident.nextAction}
                        </span>
                      </div>
                      <div className="incident-actions">
                        <span className="severity">{incident.severity}</span>
                        {profile && ["ORGANIZER", "SUPPORT"].includes(profile.role) && (
                          <>
                            <input
                              aria-label={`Resolution proof for ${incident.summary}`}
                              placeholder="Resolution proof"
                              value={resolutionProofs[incident.incidentId] ?? ""}
                              disabled={busy}
                              onChange={(event) =>
                                setResolutionProofs((current) => ({
                                  ...current,
                                  [incident.incidentId]: event.target.value,
                                }))
                              }
                            />
                            <button
                              type="button"
                              className="secondary-button"
                              disabled={busy}
                              onClick={() => resolveIncident(incident.incidentId)}
                            >
                              Resolve
                            </button>
                          </>
                        )}
                      </div>
                    </li>
                  ))}
                </ol>
              )}

              {profile && (
                <div className="incident-form">
                  <h3>Report an incident</h3>
                  <div className="incident-fields">
                    <label>
                      Severity
                      <select
                        value={severity}
                        disabled={busy}
                        onChange={(event) => setSeverity(event.target.value)}
                      >
                        <option>LOW</option>
                        <option>MEDIUM</option>
                        <option>HIGH</option>
                        <option>CRITICAL</option>
                      </select>
                    </label>
                    <label>
                      Owner
                      <input
                        value={owner}
                        disabled={busy}
                        onChange={(event) => setOwner(event.target.value)}
                      />
                    </label>
                  </div>
                  <label>
                    Summary
                    <input
                      value={summary}
                      disabled={busy}
                      onChange={(event) => setSummary(event.target.value)}
                    />
                  </label>
                  <label>
                    Immediate mitigation
                    <textarea
                      value={mitigation}
                      disabled={busy}
                      onChange={(event) => setMitigation(event.target.value)}
                    />
                  </label>
                  <label>
                    Next action
                    <textarea
                      value={nextAction}
                      disabled={busy}
                      onChange={(event) => setNextAction(event.target.value)}
                    />
                  </label>
                  <button type="button" disabled={busy} onClick={submitIncident}>
                    Record incident
                  </button>
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </main>
  );
}
