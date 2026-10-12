package xyz.openbalance.terminal.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import android.os.SystemClock
import android.provider.Settings
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import xyz.openbalance.terminal.BuildConfig
import xyz.openbalance.terminal.TerminalApplication
import xyz.openbalance.terminal.data.SaleView
import xyz.openbalance.terminal.data.ChannelView
import xyz.openbalance.terminal.data.OfflineLimits
import xyz.openbalance.terminal.data.OnlineSaleView
import xyz.openbalance.terminal.data.OrderView
import xyz.openbalance.terminal.checkout.CashierOrder
import xyz.openbalance.terminal.checkout.OnlineCheckoutException
import xyz.openbalance.terminal.protocol.CheckoutCommitments
import xyz.openbalance.terminal.protocol.InvalidOfflineExchange
import xyz.openbalance.terminal.protocol.OfflineProtocol
import xyz.openbalance.terminal.protocol.PaymentIntentProtocol
import xyz.openbalance.terminal.provisioning.ProvisioningConfig
import xyz.openbalance.terminal.provisioning.TerminalContext
import java.util.concurrent.ConcurrentHashMap
import xyz.openbalance.terminal.provisioning.ConnectedProvisioningClient
import xyz.openbalance.terminal.provisioning.FinalizedChannelVerifier
import xyz.openbalance.terminal.provisioning.TerminalPairingPending
import xyz.openbalance.terminal.provisioning.VendorProfile
import java.math.BigInteger
import xyz.openbalance.terminal.time.SignedTimeSource
import xyz.openbalance.terminal.time.TrustedTime
import xyz.openbalance.terminal.time.TrustedTimeStore

data class TerminalUiState(
    val signer: String = "",
    val configured: Boolean = false,
    val trustedTime: TrustedTime? = null,
    val sales: List<SaleView> = emptyList(),
    val channels: List<ChannelView> = emptyList(),
    val orders: List<OrderView> = emptyList(),
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
    /** Set up for a stall, but the organizer has not approved this phone yet. Checked again on its own. */
    val pairing: Boolean = false,
    /** The last automatic clock check could not reach the time service (usually: no internet). */
    val clockFailed: Boolean = false,
    /** The phone has working internet right now. */
    val online: Boolean = false,
    /** This terminal has synced once since it learned to take online payments, so it can open them. */
    val onlineReady: Boolean = false,
    /** Recent sales taken online, newest first. */
    val onlineSales: List<OnlineSaleView> = emptyList(),
    /** The online sale shown full screen while a customer pays it. */
    val focusedOnlineId: String? = null,
)

const val SALES_PAGE_SIZE = 25

/** A reserve the terminal can charge right now: inside its accept window with money and sales left. */
fun ChannelView.isChargeable(nowSeconds: Long) =
    acceptUntil > nowSeconds && salesLeft > 0 && runCatching { BigInteger(remainingUnits) > BigInteger.ZERO }.getOrDefault(false)


class TerminalViewModel(application: Application) : AndroidViewModel(application) {
    private val app = application as TerminalApplication
    private val _state = MutableStateFlow(TerminalUiState())
    val state: StateFlow<TerminalUiState> = _state.asStateFlow()
    private val timeSource = if (BuildConfig.TIME_ENDPOINT.isNotBlank() && BuildConfig.TIME_PUBLIC_KEY_DER_BASE64.isNotBlank())
        SignedTimeSource(app, BuildConfig.TIME_ENDPOINT, BuildConfig.TIME_PUBLIC_KEY_DER_BASE64) else null
    private val timeStore = TrustedTimeStore(app)

    /** Order links by order id. Memory only: a link is a capability, so it is never written to disk. */
    private val checkoutUrls = ConcurrentHashMap<String, String>()
    /** Held while an online sale is signed or cancelled, so a cancel can never race the signature. */
    private val onlineLock = Mutex()
    @Volatile private var onlineContext: TerminalContext? = null

    /** A saved sample that still verifies and is fresh on this boot, so closing the app offline keeps selling. */
    private fun restoredTime(): TrustedTime? {
        val source = timeSource ?: return null
        val saved = runCatching { timeStore.load() }.getOrNull() ?: return null
        return runCatching { source.restore(saved) }.getOrElse { timeStore.clear(); null }
    }

    private fun acceptSample(sample: TrustedTime) {
        runCatching { timeStore.save(sample) }
    }

    init {
        viewModelScope.launch(Dispatchers.IO) {
            runCatching {
                val identity = app.keys.getOrCreate()
                val config = app.provisioning.current()
                val restored = restoredTime()
                onlineContext = runCatching { app.provisioning.context() }.getOrNull()
                _state.update { it.copy(onlineSales = loadOnlineSales()) }
                _state.value = _state.value.copy(
                    signer = identity.signer,
                    trustedTime = restored ?: _state.value.trustedTime,
                    configured = timeSource != null && config != null,
                    sales = app.repository.recoverSales(SALES_PAGE_SIZE), pending = app.repository.pendingUploads(),
                    channels = app.repository.channelViews(),
                    orders = app.repository.orderViews(),
                    vendor = runCatching { app.provisioning.vendor() }.getOrNull(),
                    onlineReady = onlineContext != null,
                    message = when {
                        timeSource == null -> "This build is missing its clock setting"
                        config == null -> "Scan the setup code from the organizer"
                        else -> "Getting the time"
                    },
                )
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
        // While the organizer has not approved this phone, check in again by itself so the stall owner
        // never has to find a Refresh button.
        viewModelScope.launch(Dispatchers.IO) {
            while (isActive) {
                delay(PAIRING_RECHECK_MS)
                val current = _state.value
                if (!current.pairing || current.busy || current.scanOpen) continue
                runCatching { fetchAndInstall() }
                    .onSuccess { next -> _state.update { if (it.busy) it else next } }
            }
        }
        // Trusted time is fetched by itself whenever the phone is online, and renewed before it runs
        // out, so a cashier never has to tap "Check clock". Offline, the last sample keeps working
        // until it expires; a failed check is only surfaced once there is no usable sample left.
        viewModelScope.launch(Dispatchers.IO) {
            while (isActive) {
                val current = _state.value
                val source = timeSource
                // Renew often while online so the drift allowance stays small; offline the saved
                // sample keeps working for up to SignedTimeSource.MAX_SAMPLE_AGE_MS.
                val due = current.trustedTime?.let { SystemClock.elapsedRealtime() - it.observedMonotonicMs >= CLOCK_REFRESH_AGE_MS } ?: true
                if (source != null && due && current.configured && !current.pairing && !current.busy && !current.scanOpen) {
                    runCatching { source.sample() }
                        .onSuccess { sample ->
                            acceptSample(sample)
                            _state.update {
                                if (it.busy) it else it.copy(
                                    trustedTime = sample,
                                    timeValidSeconds = SignedTimeSource.MAX_SAMPLE_AGE_MS / 1_000,
                                    clockFailed = false,
                                )
                            }
                        }
                        .onFailure { _state.update { it.copy(clockFailed = true) } }
                }
                delay(CLOCK_POLL_MS)
            }
        }
        // Track working internet, which decides whether a sale is taken online or offline.
        viewModelScope.launch {
            app.connectivity.online.collect { online ->
                _state.update { it.copy(online = online) }
                // Back online with sales still waiting: upload right away instead of waiting for the
                // background worker's backoff, and quietly (no busy state, no message).
                if (online) launch(Dispatchers.IO) { uploadWaitingSales() }
            }
        }
        // A terminal that synced before it could take online payments learns what it needs to check
        // them (its network, contract and terminal identity) from one more sync, done by itself.
        viewModelScope.launch(Dispatchers.IO) {
            while (isActive) {
                delay(CONTEXT_RECHECK_MS)
                val current = _state.value
                if (!current.online || !current.configured || current.pairing || current.busy || current.scanOpen || onlineContext != null) continue
                runCatching { fetchAndInstall() }.onSuccess { next -> _state.update { if (it.busy) it else next } }
            }
        }
        // Online sales: while a customer is paying, ask the server often; sign the payment as soon as
        // they have signed in; notice when it is paid.
        viewModelScope.launch(Dispatchers.IO) {
            while (isActive) {
                delay(if (_state.value.onlineSales.any { it.active }) ONLINE_POLL_MS else ONLINE_IDLE_POLL_MS)
                val state = _state.value
                val config = app.provisioning.current()
                val context = onlineContext
                if (!state.online || config == null || context == null) continue
                val pollable = runCatching { app.repository.pollableOnlineSales(System.currentTimeMillis()) }.getOrNull() ?: continue
                if (pollable.isEmpty()) continue
                for (sale in pollable) runCatching { advanceOnline(sale, config, context) }
                _state.update { it.copy(onlineSales = loadOnlineSales()) }
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
                    val onlineSales = loadOnlineSales()
                    _state.update {
                        if (it.busy) it else it.copy(
                            sales = sales, pending = pending, onlineSales = onlineSales,
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
                // Ran out offline: the readiness card shows the "Connect to the internet" note.
                clockFailed = if (expired) true else it.clockFailed,
                message = if (expired && !it.busy) "Connect to the internet to check the time" else it.message,
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
        _state.update { it.copy(focusedSaleId = null, focusedOnlineId = null) }
    }

    fun focusOnlineSale(orderId: String) {
        _state.update { it.copy(focusedOnlineId = orderId) }
    }

    fun refreshTime() = viewModelScope.launch(Dispatchers.IO) {
        runBusy("Checking the clock") {
            val source = requireNotNull(timeSource) { "Trusted-time endpoint and pinned key are not configured" }
            val sample = source.sample()
            acceptSample(sample)
            _state.value.copy(
                trustedTime = sample, timeValidSeconds = SignedTimeSource.MAX_SAMPLE_AGE_MS / 1_000,
                clockFailed = false, message = "Clock checked", busy = false,
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
            runBusy("Checking in with the organizer") {
                app.provisioning.installQr(value)
                app.scheduleRelay()
                // The previous stall's name is gone with its setup; never show it while pairing.
                _state.value = _state.value.copy(configured = timeSource != null, scanOpen = false, scanPurpose = null, synced = false, pairing = false, vendor = null)
                // Check in straight away: a new stall waits here for the organizer's approval, and an
                // approved one loads its reserves without a second tap.
                fetchAndInstall()
            }
            return@launch
        }
        runBusy("Checking the customer's approval") {
            val requestId = requireNotNull(_state.value.activeRequestId)
            val source = requireNotNull(timeSource) { "Trusted-time source is unavailable" }
            val sample = requireNotNull(_state.value.trustedTime) { "Check the clock first" }
            val current = source.current(sample)
            val completed = app.repository.respond(requestId, value, (current.second + 999) / 1000, System.currentTimeMillis()) { source.current(sample) }
            app.scheduleRelay()
            val channels = app.repository.channelViews()
            _state.value.copy(
                sales = app.repository.recoverSales(_state.value.salesLimit), pending = app.repository.pendingUploads(),
                channels = channels, activeRequestId = null, scanOpen = false, scanPurpose = null,
                focusedSaleId = completed.requestId,
                message = "Payment accepted. It is paid once uploaded and settled", busy = false,
            )
        }
    }

    fun synchronize() = viewModelScope.launch(Dispatchers.IO) {
        runBusy(if (_state.value.pairing) "Checking with the organizer" else "Refreshing") { fetchAndInstall() }
    }

    /** One provisioning round trip. Throws [TerminalPairingPending] while the organizer has not approved the phone. */
    private suspend fun fetchAndInstall(): TerminalUiState {
        return run {
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
            app.provisioning.saveContext(batch.deployment, batch.terminal)
            onlineContext = app.provisioning.context()
            val channels = app.repository.channelViews()
            _state.value.copy(
                configured = timeSource != null,
                vendor = batch.vendor ?: _state.value.vendor,
                channels = channels,
                orders = app.repository.orderViews(),
                sales = app.repository.recoverSales(_state.value.salesLimit), pending = app.repository.pendingUploads(),
                message = if (_state.value.pairing || !_state.value.synced)
                    batch.vendor?.let { "Ready. This phone is now ${it.vendorName}" } ?: syncMessage(installed, imported)
                else syncMessage(installed, imported),
                synced = true,
                pairing = false,
                onlineReady = onlineContext != null,
                error = false,
                busy = false,
            )
        }
    }

    /** Sends whatever offline sales are waiting, without touching the screen unless something changed. */
    private suspend fun uploadWaitingSales() {
        runCatching {
            val config = app.provisioning.current() ?: return
            if (app.repository.pendingRelayCount() == 0) return
            delay(RECONNECT_UPLOAD_DELAY_MS)
            app.relay.runBatch(config)
            val sales = app.repository.recoverSales(_state.value.salesLimit)
            val pending = app.repository.pendingUploads()
            _state.update { if (it.busy) it else it.copy(sales = sales, pending = pending) }
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

    fun createOfflineRequest(orderId: String) = viewModelScope.launch(Dispatchers.IO) {
        runBusy("Creating payment") {
            val source = requireNotNull(timeSource) { "Trusted-time source is unavailable" }
            val sample = requireNotNull(_state.value.trustedTime) { "Check the clock first" }
            val window = source.current(sample)
            val earliest = Math.addExact(window.first, 999) / 1_000
            val latest = Math.addExact(window.second, 999) / 1_000
            val sale = app.repository.prepareOrderSale(orderId, earliest, latest, latest, System.currentTimeMillis())
            _state.value.copy(
                orders = app.repository.orderViews(), sales = app.repository.recoverSales(_state.value.salesLimit), pending = app.repository.pendingUploads(),
                focusedSaleId = sale.requestId,
                message = "Show the code to the customer", busy = false,
            )
        }
    }

    /**
     * Charges an amount keyed in on the terminal. With working internet the customer pays online
     * from their own balance with one scan; without it (or if the server cannot be reached) the sale
     * is taken offline against a reserve the customer set aside, as before.
     */
    fun chargeAmount(grossUnits: BigInteger) = viewModelScope.launch(Dispatchers.IO) {
        val start = _state.value
        if (start.online && start.onlineReady && !start.pairing && start.vendor != null) {
            var fallBackToOffline = false
            runBusy("Creating payment") {
                try {
                    openOnlineSale(grossUnits)
                } catch (error: OnlineCheckoutException) {
                    if (error.kind != OnlineCheckoutException.Kind.UNREACHABLE) throw error
                    fallBackToOffline = true
                    _state.value.copy(busy = false)
                }
            }
            if (!fallBackToOffline) return@launch
        }
        chargeOffline(grossUnits)
    }

    private suspend fun chargeOffline(grossUnits: BigInteger) {
        runBusy("Creating payment") {
            val vendor = requireNotNull(_state.value.vendor) { "Open the Terminal tab and tap Refresh while online to load this stall" }
            val source = requireNotNull(timeSource) { "Trusted-time source is unavailable" }
            val sample = requireNotNull(_state.value.trustedTime) { "Check the clock first" }
            val window = source.current(sample)
            val earliest = Math.addExact(window.first, 999) / 1_000
            val latest = Math.addExact(window.second, 999) / 1_000
            val sale = app.repository.prepareKeypadSale(
                vendor, KEYPAD_DESCRIPTION, grossUnits, earliest, latest, latest, System.currentTimeMillis(),
            )
            _state.value.copy(
                orders = app.repository.orderViews(), sales = app.repository.recoverSales(_state.value.salesLimit), pending = app.repository.pendingUploads(),
                focusedSaleId = sale.requestId, keypadCents = 0L,
                message = "", busy = false,
            )
        }
    }

    /** Opens an order on the server for the customer to scan; the poll loop takes it from there. */
    private suspend fun openOnlineSale(grossUnits: BigInteger): TerminalUiState {
        val config = requireNotNull(app.provisioning.current()) { "Terminal enrollment is not installed" }
        val vendor = requireNotNull(_state.value.vendor) { "Tap Refresh while online to load this stall" }
        val nowMs = System.currentTimeMillis()
        val suffix = ByteArray(3).also(java.security.SecureRandom()::nextBytes).joinToString("") { "%02x".format(it.toInt() and 0xff) }
        val reference = ONLINE_REFERENCE_PREFIX + onlineReferenceFormat.format(java.time.Instant.ofEpochMilli(nowMs)) + "-" + suffix
        val order = app.onlineCheckout.create(config, reference, KEYPAD_DESCRIPTION, grossUnits)
        // The code is offered for as long as an offline request is; once a customer has signed in the
        // payment has the longer window the server gave it.
        val offeredUntil = minOf(order.expiresAt, nowMs / 1_000 + ONLINE_CODE_SECONDS)
        app.repository.createOnlineSale(order.orderId, reference, KEYPAD_DESCRIPTION, grossUnits, vendor.assetSymbol, vendor.assetDecimals, offeredUntil, nowMs)
        checkoutUrls[order.orderId] = order.checkoutUrl
        return _state.value.copy(
            onlineSales = loadOnlineSales(), focusedOnlineId = order.orderId, keypadCents = 0L, message = "", busy = false,
        )
    }

    private suspend fun loadOnlineSales(): List<OnlineSaleView> =
        app.repository.onlineSaleViews(_state.value.salesLimit).map { sale -> sale.copy(checkoutUrl = checkoutUrls[sale.orderId]) }

    /**
     * One step for one online sale: learn from the server whether the customer has signed in
     * (then check and sign the payment) or whether it is paid. Anything the terminal cannot verify
     * is declined, never signed.
     */
    private suspend fun advanceOnline(sale: OnlineSaleView, config: ProvisioningConfig, context: TerminalContext) {
        val nowSeconds = System.currentTimeMillis() / 1_000
        if (sale.state == "WAITING" && nowSeconds > sale.expiresAt) {
            app.repository.transitionOnlineSale(sale.orderId, listOf("WAITING"), "EXPIRED", System.currentTimeMillis())
            return
        }
        val order = try {
            app.onlineCheckout.cashier(config, sale.orderId)
        } catch (error: OnlineCheckoutException) {
            // Gone from the server means it lapsed unpaid. Anything else is a hiccup; ask again next round.
            if (error.kind == OnlineCheckoutException.Kind.GONE && sale.state != "SIGNED")
                app.repository.transitionOnlineSale(sale.orderId, listOf(sale.state), "EXPIRED", System.currentTimeMillis())
            return
        }
        order.checkoutUrl?.let { checkoutUrls[sale.orderId] = it }
        val nowMs = System.currentTimeMillis()
        when {
            order.settlement?.status == "PAID" -> app.repository.transitionOnlineSale(
                sale.orderId, OnlineSaleView.ACTIVE_STATES + "EXPIRED", "PAID", nowMs,
                paymentId = order.paymentId, transactionHash = order.settlement.transactionHash,
            )
            order.settlement?.status == "CANCELLED" ->
                app.repository.transitionOnlineSale(sale.orderId, OnlineSaleView.ACTIVE_STATES, "CANCELLED", nowMs)
            order.state == "BOUND" && sale.state in UNSIGNED -> signOnline(sale, order, config, context)
            order.state == "READY" && sale.state in UNSIGNED -> app.repository.transitionOnlineSale(
                sale.orderId, UNSIGNED, "SIGNED", nowMs, paymentId = order.paymentId, expiresAt = order.expiresAt,
            )
            // The payment lapsed without being paid: stop waiting after a short grace for a late finality.
            sale.state == "SIGNED" && nowSeconds > sale.expiresAt + ONLINE_LATE_GRACE_SECONDS ->
                app.repository.transitionOnlineSale(sale.orderId, listOf("SIGNED"), "EXPIRED", nowMs)
            sale.state == "CUSTOMER_PAYING" && nowSeconds > sale.expiresAt ->
                app.repository.transitionOnlineSale(sale.orderId, listOf("CUSTOMER_PAYING"), "EXPIRED", nowMs)
        }
    }

    private suspend fun signOnline(sale: OnlineSaleView, order: CashierOrder, config: ProvisioningConfig, context: TerminalContext) {
        onlineLock.withLock {
            // Re-read under the lock: a cancel that got here first wins and nothing is signed.
            val current = app.repository.onlineSaleView(sale.orderId) ?: return
            if (current.state !in UNSIGNED) return
            val nowMs = System.currentTimeMillis()
            app.repository.transitionOnlineSale(sale.orderId, UNSIGNED, "CUSTOMER_PAYING", nowMs, expiresAt = order.expiresAt)
            val vendor = requireNotNull(app.provisioning.vendor()) { "Vendor profile is missing" }
            val gross = BigInteger(sale.grossUnits)
            val intent = try {
                val intent = PaymentIntentProtocol.decode(requireNotNull(order.encodedIntent) { "The server sent no payment" })
                val display = CheckoutCommitments.Display(vendor.vendorName, sale.reference, BigInteger.ONE, sale.description, sale.assetSymbol, sale.assetDecimals)
                PaymentIntentProtocol.verifyForSigning(
                    intent,
                    PaymentIntentProtocol.Expectation(
                        context.chainId, context.router, context.eventId, context.asset, context.terminalInstanceId,
                        context.terminalKeyVersion, gross,
                        CheckoutCommitments.orderReferenceHash(sale.reference, BigInteger.ONE),
                        CheckoutCommitments.receiptCommitment(display, gross),
                    ),
                    BigInteger.ONE, nowMs / 1_000,
                )
                intent
            } catch (error: InvalidOfflineExchange) {
                app.repository.transitionOnlineSale(sale.orderId, UNSIGNED + "CUSTOMER_PAYING", "DECLINED", nowMs)
                return
            }
            val digest = PaymentIntentProtocol.digest(intent)
            // The server also sends the digest it computed; a mismatch means the two sides disagree about
            // what is being signed, so nothing is signed.
            if (order.intentDigest != null && !OfflineProtocol.hex(digest).equals(order.intentDigest, ignoreCase = true)) {
                app.repository.transitionOnlineSale(sale.orderId, UNSIGNED + "CUSTOMER_PAYING", "DECLINED", nowMs)
                return
            }
            val signature = "0x" + app.keys.signDigest(digest).joinToString("") { "%02x".format(it.toInt() and 0xff) }
            try {
                app.onlineCheckout.attachSignature(config, sale.orderId, signature)
            } catch (error: OnlineCheckoutException) {
                // Already signed (a retry after a lost answer) is fine; anything else is retried next round.
                if (error.kind != OnlineCheckoutException.Kind.REFUSED) throw error
            }
            app.repository.transitionOnlineSale(
                sale.orderId, UNSIGNED + "CUSTOMER_PAYING", "SIGNED", System.currentTimeMillis(),
                paymentId = intent.paymentId, expiresAt = intent.expiresAt,
            )
        }
    }

    /** Withdraws an offline request nobody has answered, so the cashier can charge again at once. */
    fun cancelSale(requestId: String) = viewModelScope.launch(Dispatchers.IO) {
        runBusy("Cancelling") {
            app.repository.cancelUnansweredRequest(requestId, System.currentTimeMillis())
            _state.value.copy(
                orders = app.repository.orderViews(), sales = app.repository.recoverSales(_state.value.salesLimit),
                focusedSaleId = null, message = "", busy = false,
            )
        }
    }

    /** Withdraws an online sale before the terminal has signed it. After that the customer may still pay. */
    fun cancelOnlineSale(orderId: String) = viewModelScope.launch(Dispatchers.IO) {
        onlineLock.withLock {
            app.repository.transitionOnlineSale(orderId, listOf("WAITING", "CUSTOMER_PAYING"), "CANCELLED", System.currentTimeMillis())
        }
        _state.update { it.copy(onlineSales = loadOnlineSales(), focusedOnlineId = null) }
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

    /** Clears the current error once it has been on screen long enough to read. */
    private var errorClear: Job? = null

    private fun fail(error: Throwable) {
        val next = _state.value.copy(
            // Waiting for the organizer is a normal setup step, not a failure.
            busy = false, scanOpen = false, scanPurpose = null, error = error !is TerminalPairingPending,
            // A dropped connection while waiting keeps the waiting card; the next check retries.
            pairing = error is TerminalPairingPending || _state.value.pairing,
            message = if (error is TerminalPairingPending) "Waiting for the organizer to approve this phone. It checks again by itself."
            else error.message ?: "That did not work. Try again",
        )
        _state.value = next
        errorClear?.cancel()
        if (next.error) {
            errorClear = viewModelScope.launch {
                delay(ERROR_VISIBLE_MS)
                // Only this error: a newer message or action has already replaced it otherwise.
                _state.update { if (it.error && it.message == next.message) it.copy(error = false, message = "") else it }
            }
        }
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
        /** How long an error stays on screen; the next action replaces it sooner. */
        const val ERROR_VISIBLE_MS = 8_000L
        const val PAIRING_RECHECK_MS = 10_000L
        /** How often the automatic clock check looks at the sample. */
        const val CLOCK_POLL_MS = 15_000L
        /** While online, renew a trusted-time sample once it is this old. */
        const val CLOCK_REFRESH_AGE_MS = 10 * 60 * 1_000L
        const val KEYPAD_DESCRIPTION = "Custom amount"
        /** Orders opened here for online payments carry this prefix; the server keeps them out of POS imports. */
        const val ONLINE_REFERENCE_PREFIX = "OL-"
        /** How long the code on screen is offered to a customer, as long as an offline request lives. */
        const val ONLINE_CODE_SECONDS = 180L
        /** After a signed payment's window ends, how long a late finalization is still waited for. */
        const val ONLINE_LATE_GRACE_SECONDS = 120L
        const val ONLINE_POLL_MS = 2_000L
        /** Lets a fresh connection settle before the first upload attempt. */
        const val RECONNECT_UPLOAD_DELAY_MS = 1_500L
        const val ONLINE_IDLE_POLL_MS = 10_000L
        const val CONTEXT_RECHECK_MS = 15_000L
        val UNSIGNED = listOf("WAITING", "CUSTOMER_PAYING")
        val onlineReferenceFormat: java.time.format.DateTimeFormatter =
            java.time.format.DateTimeFormatter.ofPattern("yyMMdd-HHmmss").withZone(java.time.ZoneOffset.UTC)
    }
}
