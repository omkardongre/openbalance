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

# Public chain facts, re-verified against deployed bytecode at process startup.
chain = {
  id               = 10143
  name             = "Monad Testnet"
  event_id         = "0x8b1e063dcbd16a795ae9978f60d5f8e92dee63e5762ea2fb9c6170f4f8b9936a"
  router           = "0xE2d9e858d9CDa2e137BaC8ab7D6878e4B3a9cd48"
  ledger           = "0xE4bdB9b42688e6C80D6EAC722c293DaEf58C97D8"
  vault            = "0xB407dA9e84B1DA9091837AEDdCB84d91Bb96eF43"
  asset            = "0x534b2f3A21130d7a60830c2Df862319e593943A3"
  asset_decimals   = 6
  deployment_block = "64214896"
}

api_image         = "us-central1-docker.pkg.dev/openbalance-hackathon/openbalance-testnet/api@sha256:97ef35e049792b9ba5504dac7191342cfeecbd3069f840bd1029459f8810e93b"
relayer_image     = "us-central1-docker.pkg.dev/openbalance-hackathon/openbalance-testnet/relayer@sha256:9e7f3684f7c7f8c2962ceca28e69f0ae6abb25dc0d417e1e473f467f43c953d5"
web_image         = "us-central1-docker.pkg.dev/openbalance-hackathon/openbalance-testnet/web@sha256:6499ffc9ad7215d6916c3e8ac03abf7400f60c5071f223b15f66031b2d3129b7"
venue_relay_image = "us-central1-docker.pkg.dev/openbalance-hackathon/openbalance-testnet/venue-relay@sha256:a7df25bf83146b46297aa465c59b430e24239a7c456f93ed28f92914d569726d"

worker_images = {
  indexer                = "us-central1-docker.pkg.dev/openbalance-hackathon/openbalance-testnet/indexer@sha256:681677f8e5a3352e80899c8c586a25ae3e17e14b1f66aac3a1e7ce4435c44d90"
  integrations           = "us-central1-docker.pkg.dev/openbalance-hackathon/openbalance-testnet/integrations@sha256:4f1b9a1377638cca981784cb3c8fab3f653ab2ade95959552b7ffd4eeff1bd4e"
  financial-worker       = "us-central1-docker.pkg.dev/openbalance-hackathon/openbalance-testnet/financial-worker@sha256:fa4c690a2944dad8aa6c735de564a6c04164374a4a6a312277945dcbc1950535"
  venue-relay-settlement = "us-central1-docker.pkg.dev/openbalance-hackathon/openbalance-testnet/venue-relay-settlement@sha256:b3f60d95b81cebb9b655b15a1aea0a9d0c993a031309601cca428396a18e0d60"
}
