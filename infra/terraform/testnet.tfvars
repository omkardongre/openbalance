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

api_image         = "us-central1-docker.pkg.dev/openbalance-hackathon/openbalance-testnet/api@sha256:bf3aeb01e45e2228519277809c3a05bc38327e472ad7204cb6d7372a7429a4d9"
relayer_image     = "us-central1-docker.pkg.dev/openbalance-hackathon/openbalance-testnet/relayer@sha256:9b74f35009d0916bb96ca703554ace2e725064e96418549e20d406aefd4cc678"
web_image         = "us-central1-docker.pkg.dev/openbalance-hackathon/openbalance-testnet/web@sha256:072767036eca35343f0d95f47573d93d311bc70f6459eefb310cd887b5f40cdc"
venue_relay_image = "us-central1-docker.pkg.dev/openbalance-hackathon/openbalance-testnet/venue-relay@sha256:a7df25bf83146b46297aa465c59b430e24239a7c456f93ed28f92914d569726d"

worker_images = {
  indexer                = "us-central1-docker.pkg.dev/openbalance-hackathon/openbalance-testnet/indexer@sha256:9cbc105aedca8c2cadb4b36a52a1250d6b7e9bc0164aab7ee04f5dcda761ac11"
  integrations           = "us-central1-docker.pkg.dev/openbalance-hackathon/openbalance-testnet/integrations@sha256:4f1b9a1377638cca981784cb3c8fab3f653ab2ade95959552b7ffd4eeff1bd4e"
  financial-worker       = "us-central1-docker.pkg.dev/openbalance-hackathon/openbalance-testnet/financial-worker@sha256:ca8b99141e5b2ca9c327384517730350ca7dca29a43738c33ade3ade5b6d38c6"
  venue-relay-settlement = "us-central1-docker.pkg.dev/openbalance-hackathon/openbalance-testnet/venue-relay-settlement@sha256:b3f60d95b81cebb9b655b15a1aea0a9d0c993a031309601cca428396a18e0d60"
}
