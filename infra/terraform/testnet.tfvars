# Testnet environment inputs. Contains no credentials: secret values are written to Secret Manager
# by the deployment operator, never passed as Terraform variables. That includes the RPC URL, which
# embeds a provider API key and is therefore a runtime secret rather than a value recorded here.
#
# Image values are pinned to digests rather than tags. A tag identifies whichever bytes it currently
# points at, so a rollback or a re-push would silently change what a service runs; a digest cannot.
# `scripts/publish-images.mjs` rewrites the image lines below with the digests it published.

project_id     = "openbalance-hackathon"
project_number = "607263679674"
region         = "us-central1"
environment    = "testnet"

# Processes created by an apply. `integrations` is withheld because it requires credentials for a real
# ERPNext instance that does not exist yet, and the venue-relay pair is withheld because the request
# service and its settlement worker share one writable journal, which a managed request runtime and a
# separate instance cannot both hold. Both paths are proven locally; neither is proven deployed.
enabled_processes = ["api", "relayer", "web", "indexer", "financial-worker"]
# Served by the load balancer in lb.tf. `web_public_url` moves the passkey origin onto it and is set
# only once the certificate is ACTIVE; changing it invalidates every passkey enrolled on the old origin.
web_domain     = "openbalance.countersign.site"
web_public_url = "https://openbalance.countersign.site"

# Public chain facts, re-verified against deployed bytecode at process startup.
#
# This is the v2 generation. v1 was superseded by the payment-path contention change (ARCHITECTURE
# §8.4): new child bytecode required new factories, which required a new event, so the addresses
# rotated rather than being patched. The v1 addresses remain recorded in
# `deployments/testnet/archive/v1/`. Values here must match
# `deployments/testnet/financial-manifest.json`; the services re-derive code hashes at startup and
# refuse to serve on drift, so a stale value fails closed rather than serving the wrong ledger.
chain = {
  id               = 10143
  name             = "Monad Testnet"
  event_id         = "0x6d4906e4269fcb569b16c397879fa0e5e0a0e18db1607af48287005d6ee8acc3"
  router           = "0x6e83eecB0DA3b6366e8F4ee8E1Fa8FB39f4e31D2"
  ledger           = "0xecCc97B6fcaAbbC5071d2BaE80bc47F12A469FA8"
  vault            = "0x1537AdeD24e15fddC773172C263335B456Ae2E5A"
  asset            = "0x534b2f3A21130d7a60830c2Df862319e593943A3"
  asset_decimals   = 6
  deployment_block = "65010301"
}

api_image         = "us-central1-docker.pkg.dev/openbalance-hackathon/openbalance-testnet/api@sha256:4cf71587f94c4f2d4446c26b8859e40e018a497dcf62b373d6780f85e3e85765"
relayer_image     = "us-central1-docker.pkg.dev/openbalance-hackathon/openbalance-testnet/relayer@sha256:190a34baf08dcc9719274111e411ba29d212dd29969db3637270ef24ad72654e"
web_image         = "us-central1-docker.pkg.dev/openbalance-hackathon/openbalance-testnet/web@sha256:7b9825de067b406cd339539c671ed010bd9b9eb1c5f96dc3d7089f30b3ac44fa"
venue_relay_image = "us-central1-docker.pkg.dev/openbalance-hackathon/openbalance-testnet/venue-relay@sha256:a7df25bf83146b46297aa465c59b430e24239a7c456f93ed28f92914d569726d"

worker_images = {
  indexer                = "us-central1-docker.pkg.dev/openbalance-hackathon/openbalance-testnet/indexer@sha256:681677f8e5a3352e80899c8c586a25ae3e17e14b1f66aac3a1e7ce4435c44d90"
  integrations           = "us-central1-docker.pkg.dev/openbalance-hackathon/openbalance-testnet/integrations@sha256:4f1b9a1377638cca981784cb3c8fab3f653ab2ade95959552b7ffd4eeff1bd4e"
  financial-worker       = "us-central1-docker.pkg.dev/openbalance-hackathon/openbalance-testnet/financial-worker@sha256:5fb126f8cc3397752ae66c0aae015049b14abe534bdeabc85b4c1c3d602486ef"
  venue-relay-settlement = "us-central1-docker.pkg.dev/openbalance-hackathon/openbalance-testnet/venue-relay-settlement@sha256:b3f60d95b81cebb9b655b15a1aea0a9d0c993a031309601cca428396a18e0d60"
}
