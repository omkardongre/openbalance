import Link from "next/link";

export default function HomePage() {
  return (
    <main>
      <div className="page-stack">
        <section className="shell hero">
          <p className="eyebrow">OpenBalance for events</p>
          <h1>Pay exactly. Keep what is yours.</h1>
          <p className="summary">
            Pay event stalls with a passkey. Set a little aside in case the network drops, and get
            back whatever you do not spend, under rules the organizer cannot change.
          </p>
          <div className="hero-actions">
            <Link className="primary-action block-button" href="/enroll">
              Create an account
            </Link>
            <Link className="secondary-action block-button" href="/account">
              Sign in
            </Link>
          </div>
        </section>
        <section className="feature-grid" aria-label="OpenBalance guarantees">
          <article>
            <p className="feature-number">01</p>
            <h2>Pay the exact amount</h2>
            <p>Approve the stall and total you see. No top-up float, nothing left stranded.</p>
          </article>
          <article>
            <p className="feature-number">02</p>
            <h2>Works without signal</h2>
            <p>
              Set a small amount aside for a stall. Pay there by scanning a code, even with no
              network.
            </p>
          </article>
          <article>
            <p className="feature-number">03</p>
            <h2>Unspent money comes back</h2>
            <p>
              Whatever you do not spend returns to your account after the event. No form, no fee.
            </p>
          </article>
        </section>
        <nav className="staff-links" aria-label="For stalls and organizers">
          <span>For stalls and organizers</span>
          <Link href="/cashier">Cashier</Link>
          <Link href="/operations">Operations desk</Link>
          <Link href="/verify">Independent verifier</Link>
        </nav>
      </div>
    </main>
  );
}
