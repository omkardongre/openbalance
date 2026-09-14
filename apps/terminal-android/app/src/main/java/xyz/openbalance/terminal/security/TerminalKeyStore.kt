package xyz.openbalance.terminal.security

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.web3j.crypto.ECKeyPair
import org.web3j.crypto.Keys
import org.web3j.crypto.Sign
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class TerminalKeyStore(private val context: Context) {
    private val preferences = context.getSharedPreferences("terminal-key-v1", Context.MODE_PRIVATE)
    private val alias = "openbalance-terminal-wrap-v1"

    data class Identity(val signer: String, val keyVersion: Long)

    @Synchronized
    fun getOrCreate(): Identity {
        val current = preferences.getString("ciphertext", null)
        if (current == null) {
            val pair = Keys.createEcKeyPair()
            val clear = pair.privateKey.toByteArray().takeLast(32).toByteArray()
            try {
                val encrypted = encrypt(clear)
                val committed = preferences.edit()
                    .putString("ciphertext", Base64.encodeToString(encrypted.second, Base64.NO_WRAP))
                    .putString("nonce", Base64.encodeToString(encrypted.first, Base64.NO_WRAP))
                    .putString("signer", "0x${Keys.getAddress(pair)}")
                    .putLong("version", 1L)
                    .commit()
                check(committed) { "Terminal key metadata was not durably stored" }
            } finally {
                clear.fill(0)
            }
        }
        return Identity(
            signer = requireNotNull(preferences.getString("signer", null)),
            keyVersion = preferences.getLong("version", 0).also { check(it > 0) },
        )
    }

    @Synchronized
    fun signDigest(digest: ByteArray): ByteArray {
        require(digest.size == 32)
        val clear = decrypt(
            Base64.decode(requireNotNull(preferences.getString("nonce", null)), Base64.NO_WRAP),
            Base64.decode(requireNotNull(preferences.getString("ciphertext", null)), Base64.NO_WRAP),
        )
        return try {
            val pair = ECKeyPair.create(clear)
            val signature = Sign.signMessage(digest, pair, false)
            signature.r + signature.s + byteArrayOf(signature.v.first())
        } finally {
            clear.fill(0)
        }
    }

    private fun wrappingKey(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(
                KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setRandomizedEncryptionRequired(true)
                    .build(),
            )
            generateKey()
        }
    }

    private fun encrypt(clear: ByteArray): Pair<ByteArray, ByteArray> =
        Cipher.getInstance("AES/GCM/NoPadding").run {
            init(Cipher.ENCRYPT_MODE, wrappingKey())
            iv to doFinal(clear)
        }

    private fun decrypt(nonce: ByteArray, ciphertext: ByteArray): ByteArray =
        Cipher.getInstance("AES/GCM/NoPadding").run {
            init(Cipher.DECRYPT_MODE, wrappingKey(), GCMParameterSpec(128, nonce))
            doFinal(ciphertext)
        }
}
