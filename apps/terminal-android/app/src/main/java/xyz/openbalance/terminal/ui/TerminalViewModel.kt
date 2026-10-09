package xyz.openbalance.terminal.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import android.os.SystemClock
import android.provider.Settings
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import xyz.openbalance.terminal.BuildConfig
import xyz.openbalance.terminal.TerminalApplication
import xyz.openbalance.terminal.data.SaleView
import xyz.openbalance.terminal.data.ChannelView
import xyz.openbalance.terminal.data.OfflineLimits
import xyz.openbalance.terminal.data.OrderView
import xyz.openbalance.terminal.provisioning.ConnectedProvisioningClient
import xyz.openbalance.terminal.provisioning.FinalizedChannelVerifier
import xyz.openbalance.terminal.provisioning.VendorProfile
import java.math.BigInteger
import xyz.openbalance.terminal.time.SignedTimeSource
import xyz.openbalance.terminal.time.TrustedTime

data class TerminalUiState(
    val signer: String = "",
    val configured: Boolean = false,
    val trustedTime: TrustedTime? = null,
    val sales: List<SaleView> = emptyList(),
    val channels: List<ChannelView> = emptyList(),
    val orders: List<OrderView> = emptyList(),
    val selectedChannelId: String? = null,
    val activeRequestId: String? = null,
    val scanOpen: Boolean = false,
    val scanPurpose: String? = null,
    val busy: Boolean = false,
    val message: String = "Loading",
    /** Whether [message] reports a failure, so the UI can style it as an error rather than progress. */
    val error: Boolean = false,
    /** Whether provisioning has succeeded at least once this session. */
    val synced: Boolean = false,
    /** Seconds the current trusted-time sample stays usable; null when there is no usable sample. */
    val timeValidSeconds: Long? = null,
    /** Wall-clock seconds, ticked once a second, for countdowns only. Never used for payment decisions. */
    val nowSeconds: Long = System.currentTimeMillis() / 1000,
    /** The sale shown full screen: a live payment request, or the receipt just accepted. */
    val focusedSaleId: String? = null,
    /** Offline sales not settled yet, across the whole journal. */
    val pending: OfflineLimits.PendingUploads = OfflineLimits.PendingUploads(),
    /** The vendor this terminal sells for, from the last sync; null until the first sync. */
    val vendor: VendorProfile? = null,
    /** Amount keyed on the keypad, in cents. Owned here so it clears only once a charge succeeds. */
    val keypadCents: Long = 0L,
    /** How many recent sales the Sales list shows; grows with "Show more". */
    val salesLimit: Int = SALES_PAGE_SIZE,
)

const val SALES_PAGE_SIZE = 25

/** A reserve the terminal can charge right now: inside its accept window with money and sales left. */
fun ChannelView.isChargeable(nowSeconds: Long) =
    acceptUntil > nowSeconds && salesLeft > 0 && runCatching { BigInteger(remainingUnits) > BigInteger.ZERO }.getOrDefault(false)

/** Keeps the current choice while it can still be charged; otherwise the chargeable reserve that closes last. */
fun pickReserve(channels: List<ChannelView>, current: String?, nowSeconds: Long = System.currentTimeMillis() / 1000): String? {
    val open = channels.filter { it.isChargeable(nowSeconds) }
    return current?.takeIf { id -> open.any { it.channelId == id } } ?: open.maxByOrNull { it.acceptUntil }?.channelId
}

class TerminalViewModel(application: Application) : AndroidViewModel(application) {
    private val app = application as TerminalApplication
    private val _state = MutableStateFlow(TerminalUiState())
    val state: StateFlow<TerminalUiState> = _state.asStateFlow()
    private val timeSource = if (BuildConfig.TIME_ENDPOINT.isNotBlank() && BuildConfig.TIME_PUBLIC_KEY_DER_BASE64.isNotBlank())
        SignedTimeSource(app, BuildConfig.TIME_ENDPOINT, BuildConfig.TIME_PUBLIC_KEY_DER_BASE64) else null

    init {
        viewModelScope.launch(Dispatchers.IO) {
            runCatching {
                val identity = app.keys.getOrCreate()
                val config = app.provisioning.current()
                _state.value = _state.value.copy(
                    signer = identity.signer,
                    configured = timeSource != null && config != null,
                    sales = app.repository.recoverSales(SALES_PAGE_SIZE), pending = app.repository.pendingUploads(),
                    channels = app.repository.channelViews(),
                    orders = app.repository.orderViews(),
                    vendor = runCatching { app.provisioning.vendor() }.getOrNull(),
                    message = when {
                        timeSource == null -> "This build is missing its clock setting"
                        config == null -> "Scan the setup code from the organizer"
                        else -> "Tap Refresh, then Check clock, while online"
                    },
                )
                _state.update { it.copy(selectedChannelId = pickReserve(it.channels, it.selectedChannelId)) }
                if (config != null) {
                    val summary = app.relay.runBatch(config)
                    _state.value = _state.value.copy(
                        sales = app.repository.recoverSales(_state.value.salesLimit), pending = app.repository.pendingUploads(),
                        message = relayMessage("Restart recovery", summary.uploaded, summary.settled, summary.retried, summary.quarantined),
                    )
                }
            }.onFailure(::fail)
        }
        viewModelScope.launch {
            while (isActive) {
                tickClock()
                delay(1_000)
            }
        }
        // The relay worker uploads and settles sales in the background; re-read the journal so the
        // pending-upload warning clears on its own instead of only after the next tap.
        viewModelScope.launch(Dispatchers.IO) {
            while (isActive) {
                delay(JOURNAL_REFRESH_MS)
                if (_state.value.busy) continue
                runCatching {
                    val sales = app.repository.recoverSales(_state.value.salesLimit)
                    val pending = app.repository.pendingUploads()
                    _state.update {
                        if (it.busy) it else it.copy(
                            sales = sales, pending = pending,
                            selectedChannelId = pickReserve(it.channels, it.selectedChannelId, it.nowSeconds),
                        )
                    }
                }
            }
        }
    }

    /**
     * Keeps readiness honest: a sample that has aged past the source's freshness limit, or that
     * belongs to an earlier boot, is dropped so the UI stops reporting time as ready. The payment
     * path still checks freshness itself through [SignedTimeSource.current]; this only mirrors it.
     */
    private fun tickClock() {
        val current = _state.value
        val sample = current.trustedTime
        val validFor = sample?.let { source ->
            val sameBoot = runCatching { bootCount() == source.bootId }.getOrDefault(false)
            val elapsed = SystemClock.elapsedRealtime() - source.observedMonotonicMs
            if (!sameBoot || elapsed < 0) 0L else ((SignedTimeSource.MAX_SAMPLE_AGE_MS - elapsed) / 1_000).coerceAtLeast(0)
        }
        val expired = sample != null && validFor == 0L
        _state.update {
            it.copy(
                nowSeconds = System.currentTimeMillis() / 1000,
                trustedTime = if (expired) null else it.trustedTime,
                timeValidSeconds = if (expired) null else validFor,
                message = if (expired && !it.busy) "Check the clock before the next sale" else it.message,
                error = if (expired && !it.busy) false else it.error,
            )
        }
    }

    private fun bootCount(): String =
        Settings.Global.getInt(app.contentResolver, Settings.Global.BOOT_COUNT, -1).also { check(it >= 0) }.toString()

    fun focusSale(requestId: String) {
        _state.update { it.copy(focusedSaleId = requestId) }
    }

    fun dismissFocusedSale() {
        _state.update { it.copy(focusedSaleId = null) }
    }

    fun refreshTime() = viewModelScope.launch(Dispatchers.IO) {
        runBusy("Checking the clock") {
            val source = requireNotNull(timeSource) { "Trusted-time endpoint and pinned key are not configured" }
            val sample = source.sample()
            _state.value.copy(
                trustedTime = sample, timeValidSeconds = SignedTimeSource.MAX_SAMPLE_AGE_MS / 1_000,
                message = "Clock checked", busy = false,
            )
        }
    }

    fun beginScan(requestId: String) {
        _state.value = _state.value.copy(activeRequestId = requestId, scanOpen = true, scanPurpose = "ATTENDEE", message = "Scan the customer's code")
    }

    fun beginEnrollmentScan() {
        _state.value = _state.value.copy(activeRequestId = null, scanOpen = true, scanPurpose = "ENROLLMENT", message = "Scan the setup code")
    }

    fun cancelScan() {
        _state.value = _state.value.copy(scanOpen = false, scanPurpose = null, activeRequestId = null, error = false, message = "")
    }

    fun scanned(value: String) = viewModelScope.launch(Dispatchers.IO) {
        if (_state.value.scanPurpose == "ENROLLMENT") {
            runBusy("Setting up this terminal") {
                app.provisioning.installQr(value)
                app.scheduleRelay()
                _state.value.copy(configured = timeSource != null, scanOpen = false, scanPurpose = null, message = "Set up. Tap Refresh to load reserves", busy = false)
            }
            return@launch
        }
        runBusy("Checking the customer's approval") {
            val requestId = requireNotNull(_state.value.activeRequestId)
            val source = requireNotNull(timeSource) { "Trusted-time source is unavailable" }
            val sample = requireNotNull(_state.value.trustedTime) { "Check the clock first" }
            val window = source.current(sample)
            val accepted = app.repository.recordAttendeeResponse(requestId, value, (window.second + 999) / 1000, System.currentTimeMillis())
            val current = source.current(sample)
            val completed = app.repository.accept(accepted.requestId, (current.second + 999) / 1000, System.currentTimeMillis()) { source.current(sample) }
            app.scheduleRelay()
            val channels = app.repository.channelViews()
            _state.value.copy(
                sales = app.repository.recoverSales(_state.value.salesLimit), pending = app.repository.pendingUploads(),
                channels = channels, activeRequestId = null, scanOpen = false, scanPurpose = null,
                selectedChannelId = pickReserve(channels, _state.value.selectedChannelId),
                focusedSaleId = completed.requestId,
                message = "Payment accepted. It is paid once uploaded and settled", busy = false,
            )
        }
    }

    fun synchronize() = viewModelScope.launch(Dispatchers.IO) {
        runBusy("Refreshing") {
            val config = requireNotNull(app.provisioning.current()) { "Terminal enrollment is not installed" }
            val identity = app.keys.getOrCreate()
            val batch = ConnectedProvisioningClient().fetch(config, identity.signer, app.keys::signDigest)
            require(batch.terminal.terminalSigner.equals(identity.signer, true)) { "Provisioning terminal key mismatch" }
            val verifier = FinalizedChannelVerifier(config.rpcEndpoint)
            var installed = 0
            for (channelId in batch.channelIds) {
                val proof = verifier.verify(batch, channelId, identity.signer)
                if (app.repository.installVerifiedChannel(proof.snapshot, proof.proofHash, System.currentTimeMillis())) installed++
            }
            val imported = app.repository.importOrders(batch.orders, System.currentTimeMillis())
            batch.vendor?.let(app.provisioning::saveVendor)
            val channels = app.repository.channelViews()
            _state.value.copy(
                configured = timeSource != null,
                vendor = batch.vendor ?: _state.value.vendor,
                channels = channels,
                orders = app.repository.orderViews(),
                sales = app.repository.recoverSales(_state.value.salesLimit), pending = app.repository.pendingUploads(),
                // Keep the cashier's choice while it still accepts payments; otherwise default to the
                // open reserve that closes last.
                selectedChannelId = pickReserve(channels, _state.value.selectedChannelId),
                message = syncMessage(installed, imported),
                synced = true,
                busy = false,
            )
        }
    }

    fun synchronizeReceipts() = viewModelScope.launch(Dispatchers.IO) {
        runBusy("Uploading sales") {
            val config = requireNotNull(app.provisioning.current()) { "Terminal enrollment is not installed" }
            val summary = app.relay.runBatch(config)
            _state.value.copy(
                sales = app.repository.recoverSales(_state.value.salesLimit), pending = app.repository.pendingUploads(),
                message = relayMessage("Relay sync", summary.uploaded, summary.settled, summary.retried, summary.quarantined),
                busy = false,
            )
        }
    }

    fun selectChannel(channelId: String) {
        _state.value = _state.value.copy(selectedChannelId = channelId, error = false, message = "Reserve selected")
    }

    fun createOfflineRequest(orderId: String) = viewModelScope.launch(Dispatchers.IO) {
        runBusy("Creating payment") {
            val channelId = requireNotNull(_state.value.selectedChannelId) { "Choose a reserve first" }
            val source = requireNotNull(timeSource) { "Trusted-time source is unavailable" }
            val sample = requireNotNull(_state.value.trustedTime) { "Check the clock first" }
            val window = source.current(sample)
            val earliest = Math.addExact(window.first, 999) / 1_000
            val latest = Math.addExact(window.second, 999) / 1_000
            val sale = app.repository.prepareOrderSale(orderId, channelId, earliest, latest, latest, System.currentTimeMillis())
            _state.value.copy(
                orders = app.repository.orderViews(), sales = app.repository.recoverSales(_state.value.salesLimit), pending = app.repository.pendingUploads(),
                focusedSaleId = sale.requestId,
                message = "Show the code to the customer", busy = false,
            )
        }
    }

    /** Charges an amount keyed in on the terminal; works offline once the terminal has synced once. */
    fun chargeAmount(grossUnits: BigInteger) = viewModelScope.launch(Dispatchers.IO) {
        runBusy("Creating payment") {
            val vendor = requireNotNull(_state.value.vendor) { "Tap Refresh once while online to load this stall" }
            val channelId = requireNotNull(_state.value.selectedChannelId) { "Choose a reserve first" }
            val source = requireNotNull(timeSource) { "Trusted-time source is unavailable" }
            val sample = requireNotNull(_state.value.trustedTime) { "Check the clock first" }
            val window = source.current(sample)
            val earliest = Math.addExact(window.first, 999) / 1_000
            val latest = Math.addExact(window.second, 999) / 1_000
            val sale = app.repository.prepareKeypadSale(
                vendor, KEYPAD_DESCRIPTION, grossUnits, channelId, earliest, latest, latest, System.currentTimeMillis(),
            )
            _state.value.copy(
                orders = app.repository.orderViews(), sales = app.repository.recoverSales(_state.value.salesLimit), pending = app.repository.pendingUploads(),
                focusedSaleId = sale.requestId, keypadCents = 0L,
                message = "Show the code to the customer", busy = false,
            )
        }
    }

    fun setKeypadCents(cents: Long) {
        _state.update { it.copy(keypadCents = cents) }
    }

    /** Loads the next page of recent sales from the journal. */
    fun showMoreSales() = viewModelScope.launch(Dispatchers.IO) {
        val limit = _state.value.salesLimit + SALES_PAGE_SIZE
        runCatching { app.repository.recoverSales(limit) }.onSuccess { sales ->
            _state.update { it.copy(salesLimit = limit, sales = sales) }
        }
    }

    fun cameraError(error: Throwable) = fail(error)

    fun resumeAcceptance(requestId: String) = viewModelScope.launch(Dispatchers.IO) {
        runBusy("Finishing payment") {
            val source = requireNotNull(timeSource) { "Trusted-time source is unavailable" }
            val sample = requireNotNull(_state.value.trustedTime) { "Check the clock first" }
            val current = source.current(sample)
            app.repository.accept(requestId, (current.second + 999) / 1000, System.currentTimeMillis()) { source.current(sample) }
            app.scheduleRelay()
            _state.value.copy(
                sales = app.repository.recoverSales(_state.value.salesLimit), pending = app.repository.pendingUploads(),
                channels = app.repository.channelViews(), focusedSaleId = requestId,
                busy = false, message = "Payment recovered. It is paid once uploaded and settled",
            )
        }
    }

    private suspend fun runBusy(message: String, operation: suspend () -> TerminalUiState) {
        _state.value = _state.value.copy(busy = true, message = message, error = false)
        runCatching { operation() }.onSuccess { _state.value = it }.onFailure(::fail)
    }

    private fun fail(error: Throwable) {
        _state.value = _state.value.copy(
            busy = false, scanOpen = false, scanPurpose = null, error = true,
            message = error.message ?: "That did not work. Try again",
        )
    }

    /** Plain summary of a relay run; silent counters are left out. */
    private fun relayMessage(prefix: String, uploaded: Int, settled: Int, retried: Int, quarantined: Int): String {
        val parts = listOfNotNull(
            uploaded.takeIf { it > 0 }?.let { "$it uploaded" },
            settled.takeIf { it > 0 }?.let { "$it settled" },
            retried.takeIf { it > 0 }?.let { "$it will retry" },
            quarantined.takeIf { it > 0 }?.let { "$it need attention" },
        )
        val what = if (prefix == "Restart recovery") "Sales checked" else "Receipts synced"
        return if (parts.isEmpty()) "$what. Nothing waiting" else "$what: ${parts.joinToString(", ")}"
    }

    private fun syncMessage(installed: Int, imported: Int): String {
        val parts = listOfNotNull(
            installed.takeIf { it > 0 }?.let { "$it new reserve${if (it == 1) "" else "s"}" },
            imported.takeIf { it > 0 }?.let { "$it new POS order${if (it == 1) "" else "s"}" },
        )
        return if (parts.isEmpty()) "Up to date. No new reserves" else "Updated: ${parts.joinToString(", ")}"
    }

    private companion object {
        const val JOURNAL_REFRESH_MS = 20_000L
        const val KEYPAD_DESCRIPTION = "Custom amount"
    }
}
