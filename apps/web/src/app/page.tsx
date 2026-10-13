import Link from "next/link";
import { BrandMark } from "./brand-mark";

/** The stall phone app is a debug build shared from Drive; it needs an invite before it can charge. */
const STALL_APP_URL =
  "https://drive.google.com/file/d/1iVjBrYNDqoIV3lIwnwNHjduCrYUzdRiZ/view?usp=sharing";

const STEPS = [
  {
    title: "Sign up with a passkey",
    body: "Your phone's screen lock is your key. We pay the network fees, so you need no wallet app and no crypto.",
  },
  {
    title: "Set a little aside",
    body: "While you have signal, set a small amount aside for a stall you plan to visit.",
  },
  {
    title: "Pay, with or without signal",
    body: "Scan the stall's code and approve. With no network, the two phones swap codes and the sale settles later.",
  },
  {
    title: "Get the rest back",
    body: "Whatever you do not spend comes back to your account by itself once the reserve closes. No form, no fee.",
  },
];

export default function HomePage() {
  return (
    <main>
      <div className="home">
        <header className="home-nav">
          <BrandMark />
          <Link className="home-nav-link" href="/account">
            Sign in
          </Link>
        </header>

        <section className="home-hero" aria-labelledby="home-title">
          <div className="home-hero-copy">
            <p className="home-pill">
              <span className="home-pill-dot" aria-hidden="true" />
              Live on Monad testnet
            </p>
            <h1 id="home-title">
              Pay exactly.
              <br />
              <span className="home-accent">Keep what is yours.</span>
            </h1>
            <p className="summary">
              Pay event stalls with a passkey. Set a little aside in case the network drops, and get
              back whatever you do not spend, under rules the organizer cannot change.
            </p>
            <div className="home-cta">
              <Link className="primary-action" href="/enroll">
                Create an account
              </Link>
              <Link className="secondary-action" href="/account">
                Sign in
              </Link>
            </div>
            <p className="home-note">No wallet app · No seed phrase · No gas</p>
          </div>

          {/* Decorative preview of the Wallet; the real figures live on /account. */}
          <div className="home-preview" aria-hidden="true">
            <div className="preview-card">
              <div className="preview-head">
                <span>Wallet</span>
                <span className="preview-chip">Monad testnet</span>
              </div>
              <p className="preview-label">Balance</p>
              <p className="preview-balance">
                2.20 <span>USDC</span>
              </p>
              <div className="preview-reserve">
                <div className="preview-row">
                  <span>Offline money · Fresh Juice</span>
                  <strong>1.70 left</strong>
                </div>
                <div className="preview-bar">
                  <span style={{ width: "85%" }} />
                </div>
              </div>
              <ul className="preview-list">
                <li>
                  <span>
                    Noodle Bar
                    <small>Online</small>
                  </span>
                  <span className="preview-amount">
                    0.80 <em>Paid</em>
                  </span>
                </li>
                <li>
                  <span>
                    Fresh Juice
                    <small>No signal</small>
                  </span>
                  <span className="preview-amount">
                    0.30 <em>Paid</em>
                  </span>
                </li>
              </ul>
            </div>
          </div>
        </section>

        <section className="home-section" aria-labelledby="home-how">
          <p className="eyebrow">How it works</p>
          <h2 id="home-how">From sign-up to money back</h2>
          <ol className="home-steps">
            {STEPS.map((step, index) => (
              <li key={step.title}>
                <span className="home-step-number">{index + 1}</span>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="home-section home-trust" aria-labelledby="home-trust">
          <div>
            <p className="eyebrow">Why it is safe</p>
            <h2 id="home-trust">Rules the organizer cannot change</h2>
          </div>
          <ul className="home-trust-list">
            <li>
              <h3>Leftover money is yours</h3>
              <p>
                The return always pays your own account. The organizer cannot keep it or block it.
              </p>
            </li>
            <li>
              <h3>Offline is backed, not trusted</h3>
              <p>
                A stall can only take what you set aside for it, and only with both phones&apos;
                signatures.
              </p>
            </li>
            <li>
              <h3>Every sale is on chain</h3>
              <p>
                Each payment settles on Monad and splits between the stall, the organizer and the
                platform.
              </p>
            </li>
          </ul>
        </section>

        <section className="home-section" aria-labelledby="home-staff">
          <p className="eyebrow">For stalls and organizers</p>
          <h2 id="home-staff">Run a stall or an event</h2>
          <div className="home-tools">
            <a className="home-tool" href={STALL_APP_URL} target="_blank" rel="noopener noreferrer">
              <span className="home-tool-tag">Android</span>
              <h3>Stall app</h3>
              <p>
                Charge customers online or with no signal. Needs a stall invite from the organizer.
              </p>
              <span className="home-tool-go">
                Download the app <span aria-hidden="true">↗</span>
                <span className="visually-hidden"> (opens Google Drive in a new tab)</span>
              </span>
            </a>
            <Link className="home-tool" href="/operations">
              <span className="home-tool-tag">Organizer</span>
              <h3>Operations desk</h3>
              <p>Invite stalls, approve their phones and follow the event.</p>
              <span className="home-tool-go">
                Open the desk <span aria-hidden="true">→</span>
              </span>
            </Link>
          </div>
        </section>

        <footer className="home-footer">
          <p>Monad testnet with test USDC. Not audited.</p>
          <p>Built with Monad · Chainlink CRE · Envio HyperSync</p>
        </footer>
      </div>
    </main>
  );
}
