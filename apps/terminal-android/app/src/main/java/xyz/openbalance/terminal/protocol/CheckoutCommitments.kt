package xyz.openbalance.terminal.protocol

import xyz.openbalance.terminal.security.Keccak
import java.math.BigInteger

/**
 * Kotlin port of `orderReferenceHash` and `receiptCommitment` from `@openbalance/protocol`
 * (packages/protocol/src/checkout.ts), so the terminal can open a sale itself, offline, with the
 * same commitments a POS-created order carries. The receipt commitment hashes the exact bytes of
 * JavaScript's `JSON.stringify` output, so the JSON is built by hand in the protocol's key order.
 */
object CheckoutCommitments {
    data class Display(
        val vendorName: String,
        val orderReference: String,
        val orderVersion: BigInteger,
        val description: String,
        val assetSymbol: String,
        val assetDecimals: Int,
    )

    fun orderReferenceHash(reference: String, version: BigInteger): String {
        require(isBoundedLabel(reference) && version >= BigInteger.ONE) { "Invalid checkout order reference" }
        return Keccak.hex("openbalance:order:v1:$reference:$version".toByteArray(Charsets.UTF_8))
    }

    fun receiptCommitment(display: Display, grossUnits: BigInteger): String {
        require(
            isBoundedLabel(display.vendorName) && isBoundedLabel(display.orderReference) &&
                isBoundedLabel(display.description) && display.orderVersion >= BigInteger.ONE &&
                display.assetSymbol.matches(Regex("^[A-Z0-9]{2,12}$")) && display.assetDecimals in 0..36 &&
                grossUnits >= BigInteger.ONE,
        ) { "Invalid checkout receipt commitment" }
        val json = buildString {
            append("{\"schemaVersion\":1")
            append(",\"vendorName\":").append(jsonString(display.vendorName))
            append(",\"orderReference\":").append(jsonString(display.orderReference))
            append(",\"orderVersion\":").append(jsonString(display.orderVersion.toString()))
            append(",\"description\":").append(jsonString(display.description))
            append(",\"assetSymbol\":").append(jsonString(display.assetSymbol))
            append(",\"assetDecimals\":").append(display.assetDecimals)
            append(",\"grossUnits\":").append(jsonString(grossUnits.toString()))
            append('}')
        }
        return Keccak.hex(json.toByteArray(Charsets.UTF_8))
    }

    /** The protocol's `boundedLabel`: 1–160 UTF-16 code units with no control characters. */
    fun isBoundedLabel(value: String): Boolean =
        value.length in 1..160 && value.codePoints().allMatch { it > 31 && it != 127 } && !hasLoneSurrogate(value)

    /**
     * `JSON.stringify` escaping for a string that already passed [isBoundedLabel]: only the quote and
     * backslash need escaping, because control characters are rejected and every other character,
     * including non-ASCII, is emitted literally.
     */
    private fun jsonString(value: String): String = buildString {
        append('"')
        for (character in value) {
            when (character) {
                '"' -> append("\\\"")
                '\\' -> append("\\\\")
                else -> append(character)
            }
        }
        append('"')
    }

    // JSON.stringify escapes lone surrogates as \uXXXX while UTF-8 encoding would replace them, so the
    // two hashes could never agree; such a label is rejected instead.
    private fun hasLoneSurrogate(value: String): Boolean {
        var index = 0
        while (index < value.length) {
            val character = value[index]
            if (Character.isHighSurrogate(character)) {
                if (index + 1 >= value.length || !Character.isLowSurrogate(value[index + 1])) return true
                index += 2
                continue
            }
            if (Character.isLowSurrogate(character)) return true
            index++
        }
        return false
    }
}
