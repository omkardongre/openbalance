# OpenBalance Android terminal

Native, installed vendor terminal for disconnected voucher acceptance. The application uses a
bundled barcode scanner, a Room journal, and a secp256k1 terminal key encrypted by an Android
Keystore AES-GCM key. Encryption does not establish rollback resistance or hardware backing.

The terminal refuses new offline acceptance until an exact finalized channel snapshot and a valid
signed time sample have been installed. A receipt becomes accepted only in the same Room transaction
that advances the channel cursor. Camera denial, unavailable trusted time, storage failures, and
incompatible protocol versions fail closed.

Build with JDK 17 and Android SDK 37:

```bash
./gradlew :app:testDebugUnitTest :app:assembleDebug
```

Physical-device persistence, camera, secure-storage, reboot, clock, and poor-light behavior remain
deployment evidence gates even when the JVM/unit build passes.

Connected provisioning is implemented through an operator-issued QR whose API credential and HTTPS
endpoints are encrypted under Android Keystore. Synchronization imports POS orders only after the API
atomically assigns them to offline mode. The terminal independently checks the API projection block
against its RPC and verifies pinned runtime bytecode, contract bindings, channel policy, recipients,
historical terminal authority, and untouched state at one finalized block before installing a channel.

The native UI selects an installed channel and creates a durable, short-lived payment request from an
imported order only while authenticated time fits both the order and channel windows.

Offline limits come only from the reserve's finalized terms (`data/OfflineLimits.kt`): the per-sale
cap (`maxPerVoucher`), the remaining balance and the sales left (`maxVoucherCount`). Checkout shows
them on the selected reserve and disables *Charge* with the reason when an order would exceed one,
plus a countdown to the reserve's `acceptUntil`. A pending-upload banner on Checkout and Sales counts
every accepted sale still on the device, totals it, and names the earliest `submitUntil` as the
upload deadline; it turns red under 5 minutes, after the deadline, or when the relay refused a sale,
and clears as the background relay worker settles sales. Prepared sales
can resume stored authorization and display the complete signed receipt. Ordered relay upload and
installed-device evidence remain incomplete; no native end-to-end public-network proof is claimed.
