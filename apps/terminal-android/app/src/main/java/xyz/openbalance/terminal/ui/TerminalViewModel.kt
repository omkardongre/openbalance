package xyz.openbalance.terminal.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import xyz.openbalance.terminal.BuildConfig
import xyz.openbalance.terminal.TerminalApplication
import xyz.openbalance.terminal.data.SaleView
import xyz.openbalance.terminal.time.SignedTimeSource
import xyz.openbalance.terminal.time.TrustedTime

data class TerminalUiState(
    val signer: String = "",
    val configured: Boolean = false,
    val trustedTime: TrustedTime? = null,
    val sales: List<SaleView> = emptyList(),
    val activeRequestId: String? = null,
    val scanOpen: Boolean = false,
    val busy: Boolean = false,
    val message: String = "Loading durable terminal state",
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
                _state.value = _state.value.copy(
                    signer = identity.signer,
                    configured = timeSource != null,
                    sales = app.repository.recoverSales(),
                    message = if (timeSource == null) "Trusted-time configuration required" else "Refresh trusted time before offline acceptance",
                )
            }.onFailure(::fail)
        }
    }

    fun refreshTime() = viewModelScope.launch(Dispatchers.IO) {
        runBusy("Refreshing authenticated time") {
            val source = requireNotNull(timeSource) { "Trusted-time endpoint and pinned key are not configured" }
            val sample = source.sample()
            _state.value.copy(trustedTime = sample, message = "Authenticated time ready", busy = false)
        }
    }

    fun beginScan(requestId: String) {
        _state.value = _state.value.copy(activeRequestId = requestId, scanOpen = true, message = "Scan attendee response")
    }

    fun cancelScan() { _state.value = _state.value.copy(scanOpen = false, activeRequestId = null, message = "Scan cancelled") }

    fun scanned(value: String) = viewModelScope.launch(Dispatchers.IO) {
        runBusy("Verifying attendee authorization") {
            val requestId = requireNotNull(_state.value.activeRequestId)
            val source = requireNotNull(timeSource) { "Trusted-time source is unavailable" }
            val sample = requireNotNull(_state.value.trustedTime) { "Refresh authenticated time first" }
            val window = source.current(sample)
            val accepted = app.repository.recordAttendeeResponse(requestId, value, (window.second + 999) / 1000, System.currentTimeMillis())
            val current = source.current(sample)
            val completed = app.repository.accept(accepted.requestId, (current.second + 999) / 1000, System.currentTimeMillis()) { source.current(sample) }
            _state.value.copy(
                sales = app.repository.recoverSales(), activeRequestId = null, scanOpen = false,
                message = "Receipt ${completed.requestId} durably accepted pending settlement", busy = false,
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
            _state.value.copy(sales = app.repository.recoverSales(), busy = false, message = "Receipt recovered; settlement pending")
        }
    }

    private suspend fun runBusy(message: String, operation: suspend () -> TerminalUiState) {
        _state.value = _state.value.copy(busy = true, message = message)
        runCatching { operation() }.onSuccess { _state.value = it }.onFailure(::fail)
    }

    private fun fail(error: Throwable) {
        _state.value = _state.value.copy(busy = false, scanOpen = false, message = error.message ?: "Terminal operation failed")
    }
}
