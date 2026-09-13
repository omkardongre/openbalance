import Link from "next/link";

export default function HomePage() {
  return (
    <main>
      <div className="page-stack">
        <section className="shell hero">
          <p className="eyebrow">OpenBalance for events</p>
          <h1>Pay exactly. Keep what is yours.</h1>
          <p className="summary">
            Buy from independent event vendors with a passkey. Optionally reserve a small amount for
            an outage, then recover whatever was not spent under rules the organizer cannot change.
          </p>
          <div className="actions">
            <Link className="primary-action" href="/enroll">
              Create an account
            </Link>
            <Link className="secondary-action" href="/account">
              Open my account
            </Link>
            <Link className="secondary-action" href="/cashier">
              Open cashier
            </Link>
            <Link className="secondary-action" href="/operations">
              Open operations desk
            </Link>
          </div>
        </section>
        <section className="feature-grid" aria-label="OpenBalance guarantees">
          <article>
            <p className="feature-number">01</p>
            <h2>Exact purchase</h2>
            <p>Approve the vendor and total you see. A payment cannot silently change either.</p>
          </article>
          <article>
            <p className="feature-number">02</p>
            <h2>Bounded outage reserve</h2>
            <p>
              Choose the amount and terminal before disconnection. Offline acceptance stays pending.
            </p>
          </article>
          <article>
            <p className="feature-number">03</p>
            <h2>Verifiable settlement</h2>
            <p>
              Receipts retain finalized block and transaction references for independent checking.
            </p>
          </article>
        </section>
      </div>
    </main>
  );
}
