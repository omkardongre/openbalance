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

Connected channel verification/provisioning and ordered relay upload are not wired into the native
application yet. `installVerifiedChannel` is a repository boundary for a future verified bootstrap
caller; accepting a proof hash alone does not verify a deployment. Prepared sales can resume stored
authorization and display the complete signed receipt. No native end-to-end payment proof is claimed.
