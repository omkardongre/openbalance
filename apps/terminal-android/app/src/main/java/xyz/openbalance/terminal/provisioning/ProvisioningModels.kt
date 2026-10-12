package xyz.openbalance.terminal.provisioning

import java.math.BigInteger

data class ContractPin(val address: String, val runtimeCodeHash: String)
data class DeploymentPin(
    val chainId: BigInteger,
    val eventId: String,
    val asset: String,
    val registry: ContractPin,
    val ledger: ContractPin,
    val router: ContractPin,
    val vault: ContractPin,
)
data class TerminalPin(val terminalInstanceId: String, val terminalKeyVersion: BigInteger, val terminalSigner: String)
/**
 * What the terminal pins about its own deployment after a successful sync, kept so an online
 * payment can be checked against it later without asking the server again.
 */
data class TerminalContext(
    val chainId: BigInteger,
    val eventId: String,
    val asset: String,
    val router: String,
    val terminalInstanceId: String,
    val terminalKeyVersion: BigInteger,
    val terminalSigner: String,
)
data class ProjectionPin(val finalizedBlockNumber: BigInteger, val finalizedBlockHash: String)
data class PosOrder(
    val orderId: String,
    val orderRefHash: String,
    val orderVersion: BigInteger,
    val grossUnits: BigInteger,
    val receiptCommitment: String,
    val expiresAt: Long,
    val vendorName: String,
    val orderReference: String,
    val description: String,
    val assetSymbol: String,
    val assetDecimals: Int,
)
/** What the terminal needs to open a sale itself: the committed receipt display for this vendor. */
data class VendorProfile(val vendorName: String, val assetSymbol: String, val assetDecimals: Int)
data class ProvisioningBatch(
    val deployment: DeploymentPin,
    val terminal: TerminalPin,
    val projection: ProjectionPin,
    val channelIds: List<String>,
    val orders: List<PosOrder>,
    /** Absent from servers that predate terminal-created sales. */
    val vendor: VendorProfile? = null,
)
