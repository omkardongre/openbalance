package xyz.openbalance.terminal.security

import org.bouncycastle.crypto.digests.KeccakDigest

object Keccak {
    fun digest(value: ByteArray): ByteArray {
        val digest = KeccakDigest(256)
        digest.update(value, 0, value.size)
        return ByteArray(32).also { digest.doFinal(it, 0) }
    }

    fun hex(value: ByteArray): String = "0x" + digest(value).joinToString("") { "%02x".format(it.toInt() and 0xff) }
}
