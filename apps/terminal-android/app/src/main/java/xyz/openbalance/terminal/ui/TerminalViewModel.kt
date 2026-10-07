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
    val message: String = "Loading durable terminal state",
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
)

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
                    sales = app.repository.recoverSales(), pending = app.repository.pendingUploads(),
                    channels = app.repository.channelViews(),
                    orders = app.repository.orderViews(),
                    message = when {
                        timeSource == null -> "Trusted-time configuration required"
                        config == null -> "Scan the operator-issued terminal enrollment QR"
                        else -> "Synchronize while connected, then refresh trusted time"
                    },
                )
                if (config != null) {
                    val summary = app.relay.runBatch(config)
                    _state.value = _state.value.copy(
                        sales = app.repository.recoverSales(), pending = app.repository.pendingUploads(),
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
                    val sales = app.repository.recoverSales()
                    val pending = app.repository.pendingUploads()
                    _state.update { if (it.busy) it else it.copy(sales = sales, pending = pending) }
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
                message = if (expired && !it.busy) "Trusted time expired; refresh while connected" else it.message,
                error = if (expired && !it.busy) true else it.error,
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
        runBusy("Refreshing authenticated time") {
            val source = requireNotNull(timeSource) { "Trusted-time endpoint and pinned key are not configured" }
            val sample = source.sample()
            _state.value.copy(
                trustedTime = sample, timeValidSeconds = SignedTimeSource.MAX_SAMPLE_AGE_MS / 1_000,
                message = "Authenticated time ready", busy = false,
            )
        }
    }

    fun beginScan(requestId: String) {
        _state.value = _state.value.copy(activeRequestId = requestId, scanOpen = true, scanPurpose = "ATTENDEE", message = "Scan attendee response")
    }

    fun beginEnrollmentScan() {
        _state.value = _state.value.copy(activeRequestId = null, scanOpen = true, scanPurpose = "ENROLLMENT", message = "Scan terminal enrollment")
    }

    fun cancelScan() {
        _state.value = _state.value.copy(scanOpen = false, scanPurpose = null, activeRequestId = null, error = false, message = "Scan cancelled")
    }

    fun scanned(value: String) = viewModelScope.launch(Dispatchers.IO) {
        if (_state.value.scanPurpose == "ENROLLMENT") {
            runBusy("Installing protected terminal enrollment") {
                app.provisioning.installQr(value)
                app.scheduleRelay()
                _state.value.copy(configured = timeSource != null, scanOpen = false, scanPurpose = null, message = "Enrollment installed; synchronize terminal", busy = false)
            }
            return@launch
        }
        runBusy("Verifying attendee authorization") {
            val requestId = requireNotNull(_state.value.activeRequestId)
            val source = requireNotNull(timeSource) { "Trusted-time source is unavailable" }
            val sample = requireNotNull(_state.value.trustedTime) { "Refresh authenticated time first" }
            val window = source.current(sample)
            val accepted = app.repository.recordAttendeeResponse(requestId, value, (window.second + 999) / 1000, System.currentTimeMillis())
            val current = source.current(sample)
            val completed = app.repository.accept(accepted.requestId, (current.second + 999) / 1000, System.currentTimeMillis()) { source.current(sample) }
            app.scheduleRelay()
            _state.value.copy(
                sales = app.repository.recoverSales(), pending = app.repository.pendingUploads(),
                channels = app.repository.channelViews(), activeRequestId = null, scanOpen = false, scanPurpose = null,
                focusedSaleId = completed.requestId,
                message = "Receipt ${completed.requestId} durably accepted pending settlement", busy = false,
            )
        }
    }

    fun synchronize() = viewModelScope.launch(Dispatchers.IO) {
        runBusy("Verifying finalized channels and importing POS orders") {
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
            val channels = app.repository.channelViews()
            _state.value.copy(
                configured = timeSource != null,
                channels = channels,
                orders = app.repository.orderViews(),
                sales = app.repository.recoverSales(), pending = app.repository.pendingUploads(),
                // Keep the cashier's choice while it still accepts payments; otherwise default to the
                // open reserve that closes last.
                selectedChannelId = run {
                    val nowSeconds = System.currentTimeMillis() / 1000
                    val open = channels.filter { it.acceptUntil > nowSeconds }
                    _state.value.selectedChannelId?.takeIf { selected -> open.any { it.channelId == selected } }
                        ?: open.maxByOrNull { it.acceptUntil }?.channelId
                },
                message = "Verified $installed new channels; imported $imported new POS orders",
                synced = true,
                busy = false,
            )
        }
    }

    fun synchronizeReceipts() = viewModelScope.launch(Dispatchers.IO) {
        runBusy("Uploading ordered receipts and checking finality") {
            val config = requireNotNull(app.provisioning.current()) { "Terminal enrollment is not installed" }
            val summary = app.relay.runBatch(config)
            _state.value.copy(
                sales = app.repository.recoverSales(), pending = app.repository.pendingUploads(),
                message = relayMessage("Relay sync", summary.uploaded, summary.settled, summary.retried, summary.quarantined),
                busy = false,
            )
        }
    }

    fun selectChannel(channelId: String) {
        _state.value = _state.value.copy(selectedChannelId = channelId, error = false, message = "Channel selected")
    }

    fun createOfflineRequest(orderId: String) = viewModelScope.launch(Dispatchers.IO) {
        runBusy("Creating durable offline payment request") {
            val channelId = requireNotNull(_state.value.selectedChannelId) { "Select a verified channel" }
            val source = requireNotNull(timeSource) { "Trusted-time source is unavailable" }
            val sample = requireNotNull(_state.value.trustedTime) { "Refresh authenticated time first" }
            val window = source.current(sample)
            val earliest = Math.addExact(window.first, 999) / 1_000
            val latest = Math.addExact(window.second, 999) / 1_000
            val sale = app.repository.prepareOrderSale(orderId, channelId, earliest, latest, latest, System.currentTimeMillis())
            _state.value.copy(
                orders = app.repository.orderViews(), sales = app.repository.recoverSales(), pending = app.repository.pendingUploads(),
                focusedSaleId = sale.requestId,
                message = "Payment request ${sale.requestId} durably prepared", busy = false,
            )
        }
    }

    fun cameraError(error: Throwable) = fail(error)

    fun resumeAcceptance(requestId: String) = viewModelScope.launch(Dispatchers.IO) {
        runBusy("Recovering stored authorization") {
            val source = requireNotNull(timeSource) { "Trusted-time source is unavailable" }
            val sample = requireNotNull(_state.value.trustedTime) { "Refresh authenticated time first" }
            val current = source.current(sample)
            app.repository.accept(requestId, (current.second + 999) / 1000, System.currentTimeMillis()) { source.current(sample) }
            app.scheduleRelay()
            _state.value.copy(
                sales = app.repository.recoverSales(), pending = app.repository.pendingUploads(),
                channels = app.repository.channelViews(), focusedSaleId = requestId,
                busy = false, message = "Receipt recovered; settlement pending",
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
            message = error.message ?: "Terminal operation failed",
        )
    }

    private fun relayMessage(prefix: String, uploaded: Int, settled: Int, retried: Int, quarantined: Int) =
        "$prefix: $uploaded stored, $settled finalized, $retried retrying, $quarantined quarantined"

    private companion object {
        const val JOURNAL_REFRESH_MS = 20_000L
    }
}
