package xyz.openbalance.terminal.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.List
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.DateRange
import androidx.compose.material.icons.rounded.Lock
import androidx.compose.material.icons.rounded.MoreVert
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Send
import androidx.compose.material.icons.rounded.ShoppingCart
import androidx.compose.material.icons.rounded.Warning
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.IconButton
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.TextButton
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import xyz.openbalance.terminal.camera.QrScanner
import xyz.openbalance.terminal.camera.RequestQr
import xyz.openbalance.terminal.data.ChannelView
import xyz.openbalance.terminal.data.OfflineLimits
import xyz.openbalance.terminal.data.OnlineSaleView
import xyz.openbalance.terminal.data.OrderView
import xyz.openbalance.terminal.data.SaleView
import xyz.openbalance.terminal.ui.theme.MonoSmall
import xyz.openbalance.terminal.ui.theme.TerminalColors
import java.math.BigDecimal
import java.math.BigInteger
import java.math.RoundingMode
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

// Reserve channels are denominated in the event's settlement asset; the testnet event settles in USDC.
private const val CHANNEL_ASSET_DECIMALS = 6
private const val CHANNEL_ASSET_SYMBOL = "USDC"


/** A reserve this close to its acceptance deadline is flagged so the cashier can switch or sync. */
private const val RESERVE_CLOSING_SECONDS = 10 * 60L

/** Offline sales this close to their submission deadline must be uploaded now or they will not settle. */
private const val UPLOAD_URGENT_SECONDS = 5 * 60L
/** Outside the Sales tab the upload warning appears only this close to the deadline. */
private const val UPLOAD_NUDGE_SECONDS = 10 * 60L

@Composable
fun TerminalScreen(model: TerminalViewModel = viewModel()) {
    val state by model.state.collectAsStateWithLifecycle()
    AnimatedContent(
        targetState = state.scanOpen,
        transitionSpec = { fadeIn(tween(220)) togetherWith fadeOut(tween(160)) },
        label = "scanner",
    ) { scanning ->
        val focused = state.focusedSaleId?.let { id -> state.sales.firstOrNull { it.requestId == id } }
        val focusedOnline = state.focusedOnlineId?.let { id -> state.onlineSales.firstOrNull { it.orderId == id } }
        when {
            scanning -> ScannerScreen(state, model)
            // One payment owns the whole screen while it is live, as card terminals do: the cashier and
            // attendee see a single amount, a single code and a single next step.
            focused != null -> PaymentScreen(focused, state, model)
            focusedOnline != null -> OnlinePaymentScreen(focusedOnline, state, model)
            else -> HomeScreen(state, model)
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Home: two destinations, selling and the record of what was sold
// ---------------------------------------------------------------------------------------------

private enum class Tab(val label: String, val icon: ImageVector) {
    Checkout("Checkout", Icons.Rounded.ShoppingCart),
    Sales("Sales", Icons.AutoMirrored.Rounded.List),
}

@Composable
private fun HomeScreen(state: TerminalUiState, model: TerminalViewModel) {
    // Checkout first: its readiness card carries setup, pairing and clock actions until the phone is ready.
    var tab by rememberSaveable { mutableStateOf(Tab.Checkout) }
    val pendingSales = state.sales.count { isPendingSale(it, state.nowSeconds) } + state.onlineSales.count { it.active }
    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        bottomBar = {
            NavigationBar(containerColor = MaterialTheme.colorScheme.surfaceContainer) {
                Tab.entries.forEach { entry ->
                    NavigationBarItem(
                        selected = tab == entry,
                        onClick = { tab = entry },
                        icon = {
                            if (entry == Tab.Sales && pendingSales > 0) {
                                BadgedBox(badge = { Badge { Text("$pendingSales") } }) { Icon(entry.icon, null) }
                            } else {
                                Icon(entry.icon, null)
                            }
                        },
                        label = { Text(entry.label) },
                        colors = NavigationBarItemDefaults.colors(
                            selectedIconColor = TerminalColors.MintDeep,
                            selectedTextColor = TerminalColors.MintDeep,
                            indicatorColor = TerminalColors.Mint.copy(alpha = 0.18f),
                        ),
                    )
                }
            }
        },
    ) { padding ->
        AnimatedContent(
            targetState = tab,
            transitionSpec = { fadeIn(tween(160)) togetherWith fadeOut(tween(100)) },
            label = "tab",
            modifier = Modifier.padding(padding),
        ) { current ->
            when (current) {
                Tab.Checkout -> CheckoutTab(state, model)
                Tab.Sales -> SalesTab(state, model)
            }
        }
    }
}

@Composable
private fun TabList(content: androidx.compose.foundation.lazy.LazyListScope.() -> Unit) {
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(horizontal = 20.dp, vertical = 16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
        content = content,
    )
}

/** Orders a cashier can still charge: imported and not past their POS expiry. */
private fun chargeableOrders(state: TerminalUiState) =
    state.orders.filter { it.state == "IMPORTED" && it.expiresAt > state.nowSeconds }

/** Reserves that can take a sale now (open, money and sales left), latest-closing first. */
private fun usableChannels(state: TerminalUiState) =
    state.channels.filter { it.isChargeable(state.nowSeconds) }.sortedByDescending { it.acceptUntil }

/** The phone can open an online sale right now: working internet and a terminal that has synced once. */
private fun canTakeOnline(state: TerminalUiState) =
    state.online && state.onlineReady && state.configured && !state.pairing && state.vendor != null

/** The terminal can charge: online, or offline against a reserve with the clock checked. */
private fun isReady(state: TerminalUiState) = state.configured && !state.pairing &&
    (canTakeOnline(state) || (state.trustedTime != null && usableChannels(state).isNotEmpty()))

/** One plain line under "Ready to charge": how customers can pay right now. */
private fun readySubtitle(state: TerminalUiState): String {
    val offline = usableChannels(state).size
    val offlineText = "$offline customer${if (offline == 1) "" else "s"} can pay offline"
    return when {
        canTakeOnline(state) && offline > 0 -> "Customers scan and pay. $offlineText"
        canTakeOnline(state) -> "Customers scan and pay with their passkey"
        else -> offlineText
    }
}

/** A request the attendee can still answer. Expired ones hold nothing and are released on the next charge. */
private fun isLiveRequest(sale: SaleView, nowSeconds: Long) =
    (sale.state == "PREPARED" && sale.expiresAt > nowSeconds) || sale.state == "ATTENDEE_SIGNED"

@Composable
private fun CheckoutTab(state: TerminalUiState, model: TerminalViewModel) {
    val orders = chargeableOrders(state)
    val live = state.sales.firstOrNull { isLiveRequest(it, state.nowSeconds) }
    val liveOnline = state.onlineSales.firstOrNull { it.active }
    TabList {
        item { TopBar(state, model) }
        item { ReadinessCard(state, model) }
        if (uploadNeedsNudge(state)) {
            item(key = "pending") { PendingUploadBanner(state, model, onSales = false) }
        }
        liveOnline?.let { sale ->
            item(key = "liveOnline") { OnlinePaymentBanner(sale, state, model) }
        }
        live?.let { sale ->
            item(key = "live") { LivePaymentBanner(sale, state, model) }
        }
        // Keying in the amount is the primary way to sell, as on card terminals; orders pushed by a
        // connected POS appear below it only when there are some.
        item(key = "keypad") { KeypadCard(state, model) }
        if (orders.isNotEmpty()) {
            item { SectionHeader("POS orders", orders.size, "Sent by the connected point of sale") }
            items(orders, key = { "order:${it.orderId}" }) { order -> OrderRow(order, state, model) }
        }
    }
}

/** One row in the Sales list: a sale taken offline against a reserve, or online from the customer's balance. */
private sealed interface SaleItem {
    val key: String
    val createdAt: Long

    class Offline(val sale: SaleView) : SaleItem {
        override val key get() = "sale:${sale.requestId}"
        override val createdAt get() = sale.createdAt
    }

    class Online(val sale: OnlineSaleView) : SaleItem {
        override val key get() = "online:${sale.orderId}"
        override val createdAt get() = sale.createdAt
    }
}

/** Online sales worth listing: still moving, paid, or refused by this terminal. Cancelled and lapsed ones moved no money. */
private fun isListedOnline(sale: OnlineSaleView) = sale.active || sale.state == "PAID" || sale.state == "DECLINED"

@Composable
private fun SalesTab(state: TerminalUiState, model: TerminalViewModel) {
    // Charges the customer never answered moved no money, so they are not sales.
    val items = (
        state.sales.filterNot { isUnansweredRequest(it, state.nowSeconds) }.map { SaleItem.Offline(it) } +
            state.onlineSales.filter(::isListedOnline).map { SaleItem.Online(it) }
        ).sortedByDescending { it.createdAt }
    var filter by rememberSaveable { mutableStateOf(SaleFilter.All) }
    TabList {
        item {
            Text("Sales", style = MaterialTheme.typography.headlineSmall, modifier = Modifier.padding(top = 4.dp).semantics { heading() })
        }
        if (state.pending.waitingCount > 0 || state.pending.needsAttentionCount > 0) {
            item(key = "pending") { PendingUploadBanner(state, model, onSales = true) }
        }
        if (state.pending.settlingCount > 0) {
            item {
                Text(
                    "${state.pending.settlingCount} uploaded sale${if (state.pending.settlingCount == 1) "" else "s"} · " +
                        "${formatUnits(state.pending.settlingUnits.toString(), CHANNEL_ASSET_DECIMALS)} $CHANNEL_ASSET_SYMBOL " +
                        "uploaded, being confirmed",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        // Errors only; routine progress ("Payment accepted…") is shown where it happened.
        if (state.error) item { MessageLine(state) }
        item(key = "filters") {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                SaleFilter.entries.forEach { entry ->
                    val count = items.count { entry.matches(it, state.nowSeconds) }
                    FilterChip(
                        selected = filter == entry,
                        onClick = { filter = entry },
                        label = { Text(if (entry == SaleFilter.All) entry.label else "${entry.label} $count") },
                        colors = FilterChipDefaults.filterChipColors(
                            selectedContainerColor = TerminalColors.Mint.copy(alpha = 0.18f),
                            selectedLabelColor = TerminalColors.MintDeep,
                        ),
                    )
                }
            }
        }
        val shown = items.filter { filter.matches(it, state.nowSeconds) }
        if (shown.isEmpty()) {
            item {
                EmptyCard(
                    Icons.AutoMirrored.Rounded.List,
                    if (items.isEmpty()) "No sales yet" else "No ${filter.label.lowercase()} sales",
                    if (items.isEmpty()) "Payments you take appear here."
                    else "Try another filter, or load older sales below.",
                )
            }
        }
        items(shown, key = { it.key }) { item ->
            when (item) {
                is SaleItem.Offline -> SaleRow(item.sale, state) { model.focusSale(item.sale.requestId) }
                is SaleItem.Online -> OnlineSaleRow(item.sale) { model.focusOnlineSale(item.sale.orderId) }
            }
        }
        // The journal is read a page at a time; a full page means there may be older sales.
        if (state.sales.size >= state.salesLimit) {
            item(key = "more") {
                OutlinedButton(
                    onClick = model::showMoreSales,
                    enabled = !state.busy,
                    shape = MaterialTheme.shapes.medium,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                ) { Text("Show older sales") }
            }
        } else if (items.isNotEmpty()) {
            item(key = "end") {
                Text(
                    "${items.size} sale${if (items.size == 1) "" else "s"} on this terminal",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
                )
            }
        }
        item(key = "footer") { Footer() }
    }
}

private enum class SaleFilter(val label: String) {
    All("All"), Pending("Pending"), Settled("Paid"), Other("Not paid");

    fun matches(item: SaleItem, nowSeconds: Long) = when (item) {
        is SaleItem.Offline -> matches(item.sale, nowSeconds)
        is SaleItem.Online -> when (this) {
            All -> true
            Pending -> item.sale.active
            Settled -> item.sale.state == "PAID"
            Other -> item.sale.state == "DECLINED"
        }
    }

    private fun matches(sale: SaleView, nowSeconds: Long) = when (this) {
        All -> true
        Pending -> isPendingSale(sale, nowSeconds) || isLiveRequest(sale, nowSeconds)
        Settled -> sale.relayState == "SETTLED"
        Other -> !isPendingSale(sale, nowSeconds) && !isLiveRequest(sale, nowSeconds) && sale.relayState != "SETTLED"
    }
}

/**
 * The one card a cashier needs before charging: can I take a payment right now, for how long, and
 * against which reserve. Until the phone is ready it also carries the one next step (setup,
 * approval, clock), so no separate settings screen is needed.
 */
@Composable
private fun ReadinessCard(state: TerminalUiState, model: TerminalViewModel) {
    val haptics = LocalHapticFeedback.current
    val usable = usableChannels(state)
    val timeReady = state.trustedTime != null
    val ready = isReady(state)
    val (title, action) = when {
        !state.configured -> "Set up this terminal" to ("Scan setup code" to { model.beginEnrollmentScan(); Unit })
        state.pairing -> "Waiting for approval" to ("Check again" to { model.synchronize(); Unit })
        ready -> "Ready to charge" to null
        // The clock is checked by itself while online; a button appears only when that failed.
        !timeReady && state.clockFailed -> "Connect to the internet" to ("Try again" to { model.refreshTime(); Unit })
        !timeReady -> "Getting the time…" to null
        usable.isEmpty() && state.channels.any { it.acceptUntil > state.nowSeconds } ->
            "Customers' money used up" to ("Refresh" to { model.synchronize(); Unit })
        else -> "Waiting for customers" to ("Refresh" to { model.synchronize(); Unit })
    }
    val subtitle = when {
        !state.configured -> "Scan the setup code from the organizer."
        state.pairing -> "The organizer still has to approve this phone."
        ready -> readySubtitle(state)
        !timeReady && state.clockFailed -> "The phone needs the internet once to check the time before selling."
        !timeReady -> "This takes a few seconds."
        else -> "Nobody can pay offline here yet. This changes when a customer sets money aside for this stall."
    }
    Surface(
        shape = MaterialTheme.shapes.large,
        color = MaterialTheme.colorScheme.surfaceContainer,
        border = BorderStroke(1.dp, if (ready) TerminalColors.Mint.copy(alpha = 0.4f) else MaterialTheme.colorScheme.outlineVariant),
        modifier = Modifier.fillMaxWidth().animateContentSize(),
    ) {
        Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    Modifier.size(10.dp).clip(CircleShape)
                        .background(if (ready) TerminalColors.Mint else TerminalColors.Amber),
                )
                Spacer(Modifier.width(10.dp))
                Text(title, style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f).semantics { heading() })
            }
            Text(subtitle, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            // Errors always show; routine progress is shown where it happened.
            if (state.error) MessageLine(state)
            action?.let { (label, onClick) ->
                PrimaryAction(label, if (label == "Scan setup code") null else Icons.Rounded.Refresh, enabled = !state.busy) {
                    haptics.performHapticFeedback(HapticFeedbackType.LongPress); onClick()
                }
            }
            AnimatedVisibility(state.busy || (!timeReady && !state.clockFailed && state.configured && !state.pairing), enter = expandVertically() + fadeIn(), exit = shrinkVertically() + fadeOut()) {
                LinearProgressIndicator(
                    modifier = Modifier.fillMaxWidth().height(4.dp).clip(CircleShape),
                    color = TerminalColors.Mint, trackColor = MaterialTheme.colorScheme.surfaceContainerHighest,
                )
            }
        }
    }
}

/** A payment in progress: what it is, how long is left, and a way to open it or call it off. */
@Composable
private fun PaymentBanner(title: String, detail: String, onCancel: (() -> Unit)?, onOpen: () -> Unit) {
    Surface(
        shape = MaterialTheme.shapes.medium,
        color = TerminalColors.Amber.copy(alpha = 0.12f),
        border = BorderStroke(1.dp, TerminalColors.Amber.copy(alpha = 0.5f)),
        modifier = Modifier.fillMaxWidth().clip(MaterialTheme.shapes.medium)
            .clickable(role = Role.Button, onClickLabel = "Open payment", onClick = onOpen),
    ) {
        Row(Modifier.padding(start = 16.dp, top = 8.dp, bottom = 8.dp, end = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.titleSmall, color = TerminalColors.Amber)
                Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurface)
            }
            if (onCancel != null) {
                TextButton(onClick = onCancel) { Text("Cancel", color = MaterialTheme.colorScheme.onSurfaceVariant) }
            }
            TextButton(onClick = onOpen) { Text("Open", color = TerminalColors.Amber) }
        }
    }
}

@Composable
private fun LivePaymentBanner(sale: SaleView, state: TerminalUiState, model: TerminalViewModel) {
    PaymentBanner(
        "Payment in progress",
        "${formatUnits(sale.grossUnits, CHANNEL_ASSET_DECIMALS)} $CHANNEL_ASSET_SYMBOL · " +
            if (sale.state == "ATTENDEE_SIGNED") "response received" else "expires in ${countdown(sale.expiresAt - state.nowSeconds)}",
        // Once the customer's answer is in, the payment is being accepted and cannot be called off.
        onCancel = if (sale.state == "PREPARED") ({ model.cancelSale(sale.requestId) }) else null,
        onOpen = { model.focusSale(sale.requestId) },
    )
}

@Composable
private fun OnlinePaymentBanner(sale: OnlineSaleView, state: TerminalUiState, model: TerminalViewModel) {
    PaymentBanner(
        "Payment in progress",
        "${formatUnits(sale.grossUnits, sale.assetDecimals)} ${sale.assetSymbol} · " + when (sale.state) {
            "WAITING" -> "waiting for the customer · ${countdown(sale.expiresAt - state.nowSeconds)}"
            else -> "the customer is paying"
        },
        onCancel = if (sale.state == "WAITING" || sale.state == "CUSTOMER_PAYING") ({ model.cancelOnlineSale(sale.orderId) }) else null,
        onOpen = { model.focusOnlineSale(sale.orderId) },
    )
}

/** Off the Sales tab the warning shows only when time is short or the stall needs to act. */
private fun uploadNeedsNudge(state: TerminalUiState): Boolean {
    val pending = state.pending
    if (pending.needsAttentionCount > 0) return true
    if (pending.waitingCount == 0) return false
    val left = pending.uploadBy?.let { it - state.nowSeconds } ?: return false
    return left <= UPLOAD_NUDGE_SECONDS
}

/**
 * Offline sales still on this device. They are paid only once they reach the chain before their
 * reserve's submission deadline, so the warning names the deadline and escalates as it nears.
 */
@Composable
private fun PendingUploadBanner(state: TerminalUiState, model: TerminalViewModel, onSales: Boolean) {
    val pending = state.pending
    val uploadBy = pending.uploadBy
    val left = uploadBy?.let { it - state.nowSeconds }
    val missed = left != null && left <= 0
    val urgent = missed || (left != null && left <= UPLOAD_URGENT_SECONDS) || pending.needsAttentionCount > 0
    val color = if (urgent) TerminalColors.Coral else TerminalColors.Amber
    val haptics = LocalHapticFeedback.current
    Surface(
        shape = MaterialTheme.shapes.medium,
        color = color.copy(alpha = 0.12f),
        border = BorderStroke(1.dp, color.copy(alpha = 0.5f)),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Rounded.Warning, "Warning", tint = color, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp))
                Text(
                    if (pending.waitingCount > 0) {
                        "${pending.waitingCount} offline sale${if (pending.waitingCount == 1) "" else "s"} not uploaded · " +
                            "${formatUnits(pending.waitingUnits.toString(), CHANNEL_ASSET_DECIMALS)} $CHANNEL_ASSET_SYMBOL"
                    } else {
                        "Sales need attention"
                    },
                    style = MaterialTheme.typography.titleSmall, color = color,
                )
            }
            if (uploadBy != null && left != null) {
                Text(
                    if (missed) {
                        "The upload deadline passed at ${clock(uploadBy)}. Connect to the internet now; sales that miss it are not paid."
                    } else {
                        "Uploads by itself when online. Upload before ${clock(uploadBy)} (${countdown(left)} left) to get paid."
                    },
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurface,
                )
            }
            if (pending.needsAttentionCount > 0) {
                Text(
                    "${pending.needsAttentionCount} sale${if (pending.needsAttentionCount == 1) " was" else "s were"} not accepted. Ask the organizer to check ${if (pending.needsAttentionCount == 1) "it" else "them"}.",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurface,
                )
            }
            // Upload runs by itself once online, so the button is only a fallback and lives on Sales.
            if (onSales && pending.waitingCount > 0) {
                TextButton(
                    onClick = { haptics.performHapticFeedback(HapticFeedbackType.LongPress); model.synchronizeReceipts() },
                    enabled = state.configured && !state.busy,
                ) {
                    Icon(Icons.Rounded.Send, null, modifier = Modifier.size(16.dp))
                    Spacer(Modifier.width(6.dp))
                    Text("Upload now", style = MaterialTheme.typography.labelLarge)
                }
            }
        }
    }
}

@Composable
private fun TopBar(state: TerminalUiState, model: TerminalViewModel) {
    var menuOpen by remember { mutableStateOf(false) }
    var confirmReenroll by remember { mutableStateOf(false) }
    Row(Modifier.fillMaxWidth().padding(top = 4.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        BrandMark()
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text("OpenBalance", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
            // Which stall this phone sells for, so a phone moved between stalls is never ambiguous.
            Text(
                state.vendor?.vendorName?.let { "Terminal · $it" } ?: "Terminal",
                style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
            )
        }

        // Shown only when it adds something: the cards below already say when the phone is ready.
        when {
            state.busy -> StatusPill("Working", TerminalColors.Amber, pulsing = true)
            !state.configured -> StatusPill("Not set up", TerminalColors.Muted, pulsing = false)
        }
        // Rare actions, on every tab: refresh, and "Tap ⋮, then Scan setup code" to pair or re-pair.
        Box {
            IconButton(onClick = { menuOpen = true }, enabled = !state.busy) {
                Icon(Icons.Rounded.MoreVert, contentDescription = "More options")
            }
            DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                // Everything syncs by itself; this is only a nudge, so it sits in the menu.
                if (state.configured) {
                    DropdownMenuItem(
                        text = { Text("Refresh") },
                        leadingIcon = { Icon(Icons.Rounded.Refresh, null, modifier = Modifier.size(18.dp)) },
                        onClick = { menuOpen = false; model.synchronize() },
                    )
                }
                DropdownMenuItem(
                    text = { Text("Scan setup code") },
                    leadingIcon = { ScanGlyph(18.dp, MaterialTheme.colorScheme.onSurface) },
                    onClick = {
                        menuOpen = false
                        if (state.configured) confirmReenroll = true else model.beginEnrollmentScan()
                    },
                )
            }
        }
    }
    if (confirmReenroll) {
        AlertDialog(
            onDismissRequest = { confirmReenroll = false },
            title = { Text("Scan a new setup code?") },
            text = {
                Text(
                    state.vendor?.let { "This phone stops selling for ${it.vendorName} and sells for the stall in the new code. Your sales stay on this phone." }
                        ?: "Scan the setup code for your stall. Your sales stay on this phone.",
                )
            },
            confirmButton = {
                TextButton(onClick = { confirmReenroll = false; model.beginEnrollmentScan() }) { Text("Scan code") }
            },
            dismissButton = { TextButton(onClick = { confirmReenroll = false }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun BrandMark() {
    Box(
        Modifier.size(44.dp).clip(RoundedCornerShape(14.dp))
            .background(Brush.linearGradient(listOf(TerminalColors.Mint, TerminalColors.MintDeep))),
        contentAlignment = Alignment.Center,
    ) {
        Canvas(Modifier.size(22.dp)) {
            // Two offset rings: a balance held and a balance settled.
            val stroke = Stroke(width = size.minDimension * 0.16f)
            drawCircle(TerminalColors.OnMint, radius = size.minDimension * 0.30f, center = Offset(size.width * 0.38f, size.height / 2), style = stroke)
            drawCircle(TerminalColors.OnMint, radius = size.minDimension * 0.30f, center = Offset(size.width * 0.62f, size.height / 2), style = stroke)
        }
    }
}

@Composable
private fun StatusPill(text: String, color: Color, pulsing: Boolean) {
    val transition = rememberInfiniteTransition(label = "pulse")
    val alpha by transition.animateFloat(
        initialValue = 1f,
        targetValue = if (pulsing) 0.35f else 1f,
        animationSpec = infiniteRepeatable(tween(700), RepeatMode.Reverse),
        label = "pulseAlpha",
    )
    val tint by animateColorAsState(color, spring(stiffness = Spring.StiffnessMediumLow), label = "pillColor")
    Row(
        Modifier.clip(CircleShape).background(tint.copy(alpha = 0.12f))
            .border(1.dp, tint.copy(alpha = 0.35f), CircleShape)
            .padding(horizontal = 12.dp, vertical = 6.dp)
            .semantics { contentDescription = "Terminal status: $text" },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(8.dp).clip(CircleShape).background(tint.copy(alpha = if (pulsing) alpha else 1f)))
        Spacer(Modifier.width(8.dp))
        Text(text, style = MaterialTheme.typography.labelMedium, color = tint, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
private fun MessageLine(state: TerminalUiState) {
    val color = if (state.error) TerminalColors.Coral else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.8f)
    AnimatedContent(targetState = state.message to state.error, label = "message",
        transitionSpec = { fadeIn(tween(180)) togetherWith fadeOut(tween(120)) }) { (message, error) ->
        Row(verticalAlignment = Alignment.Top) {
            if (error) {
                Icon(Icons.Rounded.Warning, null, tint = color, modifier = Modifier.size(18.dp).padding(top = 1.dp))
                Spacer(Modifier.width(8.dp))
            }
            Text(friendlyMessage(message), style = MaterialTheme.typography.bodyMedium, color = color)
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------------------------

/** Press feedback shared by every tappable surface: a quick spring squash, like a physical key. */
@Composable
private fun pressScale(source: MutableInteractionSource): Float {
    val pressed by source.collectIsPressedAsState()
    val scale by animateFloatAsState(
        if (pressed) 0.96f else 1f,
        spring(dampingRatio = Spring.DampingRatioMediumBouncy, stiffness = Spring.StiffnessMedium),
        label = "press",
    )
    return scale
}

@Composable
private fun PrimaryAction(label: String, icon: ImageVector?, enabled: Boolean, onClick: () -> Unit) {
    val source = remember { MutableInteractionSource() }
    Button(
        onClick = onClick,
        enabled = enabled,
        interactionSource = source,
        shape = MaterialTheme.shapes.large,
        contentPadding = PaddingValues(horizontal = 24.dp, vertical = 18.dp),
        colors = ButtonDefaults.buttonColors(
            containerColor = TerminalColors.Mint,
            contentColor = TerminalColors.OnMint,
            disabledContainerColor = MaterialTheme.colorScheme.surfaceContainerHighest,
        ),
        modifier = Modifier.fillMaxWidth().heightIn(min = 64.dp).scale(pressScale(source)),
    ) {
        if (icon != null) Icon(icon, null, modifier = Modifier.size(22.dp)) else ScanGlyph(22.dp, TerminalColors.OnMint)
        Spacer(Modifier.width(10.dp))
        Text(label, style = MaterialTheme.typography.titleMedium)
    }
}

/** QR viewfinder glyph; the core icon set has no scan icon. */
@Composable
private fun ScanGlyph(size: Dp, color: Color) {
    Canvas(Modifier.size(size)) {
        val w = this.size.width
        val arm = w * 0.30f
        val stroke = w * 0.11f
        val corners = listOf(Offset(0f, 0f) to Offset(1f, 1f), Offset(w, 0f) to Offset(-1f, 1f),
            Offset(0f, w) to Offset(1f, -1f), Offset(w, w) to Offset(-1f, -1f))
        corners.forEach { (origin, direction) ->
            val inset = Offset(origin.x + direction.x * stroke / 2, origin.y + direction.y * stroke / 2)
            drawLine(color, inset, Offset(inset.x + direction.x * arm, inset.y), stroke, StrokeCap.Round)
            drawLine(color, inset, Offset(inset.x, inset.y + direction.y * arm), stroke, StrokeCap.Round)
        }
        drawRoundRect(color, Offset(w * 0.36f, w * 0.36f), Size(w * 0.28f, w * 0.28f), CornerRadius(w * 0.05f))
    }
}

// ---------------------------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------------------------

@Composable
private fun SectionHeader(title: String, count: Int, subtitle: String) {
    Column(Modifier.padding(top = 14.dp, bottom = 2.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(title, style = MaterialTheme.typography.titleLarge, modifier = Modifier.semantics { heading() })
            if (count > 0) {
                Spacer(Modifier.width(8.dp))
                Text(
                    "$count", style = MaterialTheme.typography.labelMedium, color = TerminalColors.Mint,
                    modifier = Modifier.clip(CircleShape).background(TerminalColors.Mint.copy(alpha = 0.14f)).padding(horizontal = 8.dp, vertical = 2.dp),
                )
            }
        }
        Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun EmptyCard(icon: ImageVector, title: String, body: String) {
    Surface(
        shape = MaterialTheme.shapes.medium,
        color = MaterialTheme.colorScheme.surfaceContainerLow,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(Modifier.padding(18.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(40.dp).clip(CircleShape).background(MaterialTheme.colorScheme.surfaceContainerHighest), contentAlignment = Alignment.Center) {
                Icon(icon, null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(20.dp))
            }
            Spacer(Modifier.width(14.dp))
            Column {
                Text(title, style = MaterialTheme.typography.titleSmall)
                Text(body, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

/** Keypad key height: still above the 44 dp touch target, small enough that keys and Charge fit. */
private val KEY_HEIGHT = 46.dp

/** One-tap amounts on Checkout, in cents. */
private val QUICK_AMOUNTS_CENTS = listOf(50L, 100L, 200L, 500L)

/** Largest keyed amount, in cents: 9,999.99. */
private const val KEYPAD_MAX_CENTS = 999_999L

/**
 * Custom-amount keypad. Digits shift in from the right (typing 1, 2, 5 shows 1.25), the entry
 * style card terminals use, so a cashier never has to find a decimal point.
 */
@Composable
private fun KeypadCard(state: TerminalUiState, model: TerminalViewModel) {
    val haptics = LocalHapticFeedback.current
    val cents = state.keypadCents
    val decimals = state.vendor?.assetDecimals ?: CHANNEL_ASSET_DECIMALS
    val symbol = state.vendor?.assetSymbol ?: CHANNEL_ASSET_SYMBOL
    val units = if (decimals >= 2) BigInteger.valueOf(cents).multiply(BigInteger.TEN.pow(decimals - 2)) else BigInteger.ZERO
    val reserves = usableChannels(state)
    // Online, the customer pays from their own balance: no reserve, clock or offline limit applies.
    val onlineMode = canTakeOnline(state)
    val block = if (!onlineMode && cents > 0 && reserves.isNotEmpty()) OfflineLimits.chargeBlock(units, reserves) else null
    val live = state.sales.any { isLiveRequest(it, state.nowSeconds) }
    val canCharge = cents > 0 && state.vendor != null && !state.busy &&
        (onlineMode || (reserves.isNotEmpty() && block == null && state.trustedTime != null && !live))
    // Most stall prices are a few round amounts, so those are one tap; the full keypad opens only
    // for anything else and stays out of the way otherwise.
    var keypadOpen by rememberSaveable { mutableStateOf(false) }
    Surface(
        shape = MaterialTheme.shapes.large,
        color = MaterialTheme.colorScheme.surfaceContainer,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("New sale", style = MaterialTheme.typography.titleMedium, modifier = Modifier.semantics { heading() })
            Row(
                verticalAlignment = Alignment.Bottom,
                horizontalArrangement = Arrangement.Center,
                modifier = Modifier.fillMaxWidth().clip(MaterialTheme.shapes.medium)
                    .clickable(enabled = !state.busy, role = Role.Button, onClickLabel = "Type an amount") { keypadOpen = true }
                    .semantics { contentDescription = "Amount ${formatCents(cents)} $symbol" },
            ) {
                // Smaller while the keypad is open, so amount, keys and Charge fit on one screen.
                Text(
                    formatCents(cents),
                    style = if (keypadOpen) MaterialTheme.typography.displaySmall else MaterialTheme.typography.displayMedium,
                    color = if (cents == 0L) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
                )
                Spacer(Modifier.width(6.dp))
                Text(symbol, style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(bottom = 8.dp))
            }
            val hint = when {
                state.vendor == null -> "Open the Terminal tab and tap Refresh while online to load this stall"
                block is OfflineLimits.Block.OverPerSale ->
                    "Over the ${formatUnits(block.maxPerSaleUnits.toString(), CHANNEL_ASSET_DECIMALS)} offline limit per sale"
                block is OfflineLimits.Block.OverRemaining ->
                    "Only ${formatUnits(block.remainingUnits.toString(), CHANNEL_ASSET_DECIMALS)} left on this reserve"
                block == OfflineLimits.Block.NoSalesLeft -> "This reserve has no sales left"
                block is OfflineLimits.Block.OverEveryReserve ->
                    "Too much to pay offline. The most one customer can pay here is " +
                        "${formatUnits(block.bestUnits.toString(), CHANNEL_ASSET_DECIMALS)} $CHANNEL_ASSET_SYMBOL"
                else -> null
            }
            hint?.let {
                Text(
                    it, style = MaterialTheme.typography.bodySmall,
                    color = if (block != null) TerminalColors.Amber else MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                QUICK_AMOUNTS_CENTS.forEach { amount ->
                    FilterChip(
                        selected = cents == amount && !keypadOpen,
                        onClick = {
                            haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                            model.setKeypadCents(amount); keypadOpen = false
                        },
                        enabled = !state.busy,
                        label = { Text(formatCents(amount), style = MaterialTheme.typography.titleSmall, modifier = Modifier.fillMaxWidth(), textAlign = TextAlign.Center) },
                        colors = FilterChipDefaults.filterChipColors(
                            selectedContainerColor = TerminalColors.Mint.copy(alpha = 0.18f),
                            selectedLabelColor = TerminalColors.MintDeep,
                        ),
                        modifier = Modifier.weight(1f).heightIn(min = 48.dp),
                    )
                }
            }
            TextButton(onClick = { keypadOpen = !keypadOpen }, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) {
                Text(if (keypadOpen) "Hide keypad" else "Other amount")
            }
            val rows = listOf(listOf("1", "2", "3"), listOf("4", "5", "6"), listOf("7", "8", "9"), listOf("C", "0", "⌫"))
            AnimatedVisibility(keypadOpen, enter = expandVertically() + fadeIn(), exit = shrinkVertically() + fadeOut()) {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            rows.forEach { row ->
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.fillMaxWidth()) {
                    row.forEach { key ->
                        KeypadKey(
                            key,
                            label = when (key) { "C" -> "Clear amount"; "⌫" -> "Delete last digit"; else -> key },
                            enabled = !state.busy,
                            modifier = Modifier.weight(1f),
                        ) {
                            haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                            model.setKeypadCents(
                                when (key) {
                                    "C" -> 0L
                                    "⌫" -> cents / 10
                                    else -> (cents * 10 + key.toLong()).takeIf { it <= KEYPAD_MAX_CENTS } ?: cents
                                },
                            )
                        }
                    }
                }
            }
            }
            }
            val source = remember { MutableInteractionSource() }
            Button(
                onClick = {
                    haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                    // Cleared by the view model once the request is stored, so a failed charge keeps the amount.
                    model.chargeAmount(units)
                },
                enabled = canCharge,
                interactionSource = source,
                shape = MaterialTheme.shapes.medium,
                colors = ButtonDefaults.buttonColors(containerColor = TerminalColors.Mint, contentColor = TerminalColors.OnMint),
                modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp).scale(pressScale(source)),
            ) {
                Text(
                    if (cents == 0L) "Charge" else "Charge ${formatCents(cents)} $symbol",
                    style = MaterialTheme.typography.titleMedium,
                )
            }
        }
    }
}

@Composable
private fun KeypadKey(key: String, label: String, enabled: Boolean, modifier: Modifier, onClick: () -> Unit) {
    val source = remember { MutableInteractionSource() }
    Surface(
        shape = MaterialTheme.shapes.medium,
        color = MaterialTheme.colorScheme.surfaceContainerHighest,
        modifier = modifier.height(KEY_HEIGHT).scale(pressScale(source)).clip(MaterialTheme.shapes.medium)
            .clickable(enabled = enabled, role = Role.Button, interactionSource = source, indication = null, onClick = onClick)
            .semantics { contentDescription = label },
    ) {
        Box(contentAlignment = Alignment.Center, modifier = Modifier.fillMaxWidth().height(KEY_HEIGHT)) {
            Text(key, style = MaterialTheme.typography.headlineSmall, color = MaterialTheme.colorScheme.onSurface)
        }
    }
}

private fun formatCents(cents: Long): String = "%d.%02d".format(cents / 100, cents % 100)

/** One compact row per order, like a POS ticket list: what, how much, and a single Charge action. */
@Composable
private fun OrderRow(order: OrderView, state: TerminalUiState, model: TerminalViewModel) {
    val haptics = LocalHapticFeedback.current
    val live = state.sales.any { isLiveRequest(it, state.nowSeconds) }
    val reserves = usableChannels(state)
    val block = reserves.takeIf { it.isNotEmpty() }?.let { OfflineLimits.chargeBlock(BigInteger(order.grossUnits), it) }
    val canCharge = reserves.isNotEmpty() && block == null && state.trustedTime != null && !state.busy && !live
    Surface(
        shape = MaterialTheme.shapes.medium,
        color = MaterialTheme.colorScheme.surfaceContainer,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(Modifier.padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(order.description, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(
                    "${order.orderReference} · expires ${clock(order.expiresAt)}",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
                Row(verticalAlignment = Alignment.Bottom, modifier = Modifier.padding(top = 2.dp)) {
                    Text(formatUnits(order.grossUnits, order.assetDecimals), style = MaterialTheme.typography.titleLarge)
                    Spacer(Modifier.width(4.dp))
                    Text(order.assetSymbol, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(bottom = 3.dp))
                }
                block?.let {
                    Text(
                        when (it) {
                            is OfflineLimits.Block.OverPerSale ->
                                "Over the ${formatUnits(it.maxPerSaleUnits.toString(), CHANNEL_ASSET_DECIMALS)} offline limit per sale"
                            is OfflineLimits.Block.OverRemaining ->
                                "Only ${formatUnits(it.remainingUnits.toString(), CHANNEL_ASSET_DECIMALS)} left on this reserve"
                            OfflineLimits.Block.NoSalesLeft -> "This reserve has no sales left"
                            is OfflineLimits.Block.OverEveryReserve ->
                                "Most one customer can pay offline: ${formatUnits(it.bestUnits.toString(), CHANNEL_ASSET_DECIMALS)}"
                        },
                        style = MaterialTheme.typography.bodySmall, color = TerminalColors.Amber,
                    )
                }
            }
            Spacer(Modifier.width(12.dp))
            val source = remember { MutableInteractionSource() }
            Button(
                onClick = { haptics.performHapticFeedback(HapticFeedbackType.LongPress); model.createOfflineRequest(order.orderId) },
                enabled = canCharge,
                interactionSource = source,
                shape = MaterialTheme.shapes.medium,
                colors = ButtonDefaults.buttonColors(containerColor = TerminalColors.Mint, contentColor = TerminalColors.OnMint),
                contentPadding = PaddingValues(horizontal = 20.dp, vertical = 14.dp),
                modifier = Modifier.heightIn(min = 52.dp).scale(pressScale(source))
                    .semantics { contentDescription = "Charge ${order.description} ${formatUnits(order.grossUnits, order.assetDecimals)} ${order.assetSymbol}" },
            ) { Text("Charge", style = MaterialTheme.typography.titleSmall) }
        }
    }
}

@Composable
private fun OnlineSaleRow(sale: OnlineSaleView, onOpen: () -> Unit) {
    Surface(
        shape = MaterialTheme.shapes.medium,
        color = MaterialTheme.colorScheme.surfaceContainer,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        modifier = Modifier.fillMaxWidth().clip(MaterialTheme.shapes.medium)
            .clickable(role = Role.Button, onClickLabel = "Open sale", onClick = onOpen),
    ) {
        Row(Modifier.padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("${formatUnits(sale.grossUnits, sale.assetDecimals)} ${sale.assetSymbol}", style = MaterialTheme.typography.titleMedium)
                Text(
                    "${sale.description} · ${clock(sale.createdAt)}",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
                if (sale.state == "DECLINED") {
                    Text("The payment request did not match", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            Spacer(Modifier.width(12.dp))
            StateBadge(
                when (sale.state) {
                    "WAITING" -> "PREPARED"
                    "CUSTOMER_PAYING", "SIGNED" -> "PAYING"
                    "PAID" -> "PAID"
                    else -> "MISSED"
                },
            )
        }
    }
}

@Composable
private fun SaleRow(sale: SaleView, state: TerminalUiState, onOpen: () -> Unit) {
    val order = state.orders.firstOrNull { it.requestId == sale.requestId }
    Surface(
        shape = MaterialTheme.shapes.medium,
        color = MaterialTheme.colorScheme.surfaceContainer,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        modifier = Modifier.fillMaxWidth().clip(MaterialTheme.shapes.medium)
            .clickable(role = Role.Button, onClickLabel = "Open sale", onClick = onOpen),
    ) {
        Row(Modifier.padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(
                    "${formatUnits(sale.grossUnits, CHANNEL_ASSET_DECIMALS)} $CHANNEL_ASSET_SYMBOL",
                    style = MaterialTheme.typography.titleMedium,
                )
                Text(
                    listOfNotNull(order?.description ?: "Sale", clock(sale.createdAt)).joinToString(" · "),
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
                // Past the upload deadline nothing retries any more; say what happened instead.
                when {
                    saleBadge(sale, state.nowSeconds) == "MISSED" ->
                        Text("Not uploaded in time", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    sale.lastUploadError != null ->
                        Text("Upload failed. It will retry", color = TerminalColors.Coral, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            Spacer(Modifier.width(12.dp))
            StateBadge(saleBadge(sale, state.nowSeconds))
        }
    }
}

/** A charge whose request ran out before the customer answered: nothing was signed or charged. */
private fun isUnansweredRequest(sale: SaleView, nowSeconds: Long) =
    (sale.state == "PREPARED" && sale.expiresAt <= nowSeconds) || sale.state == "EXPIRED"

private fun isPendingSale(sale: SaleView, nowSeconds: Long) =
    sale.state == "ACCEPTED" && sale.relayState != "SETTLED" &&
        !OfflineLimits.isMissed(sale.relayState, sale.submitUntil, nowSeconds)

private fun saleBadge(sale: SaleView, nowSeconds: Long) = when {
    sale.state == "ACCEPTED" -> when {
        sale.relayState == "SETTLED" -> "SETTLED"
        OfflineLimits.isMissed(sale.relayState, sale.submitUntil, nowSeconds) -> "MISSED"
        else -> "PENDING"
    }
    sale.state == "PREPARED" && sale.expiresAt <= nowSeconds -> "EXPIRED"
    else -> sale.state
}

// ---------------------------------------------------------------------------------------------
// Payment: one full screen per live payment, then a result screen with the receipt
// ---------------------------------------------------------------------------------------------

@Composable
private fun PaymentScreen(sale: SaleView, state: TerminalUiState, model: TerminalViewModel) {
    val haptics = LocalHapticFeedback.current
    val order = state.orders.firstOrNull { it.requestId == sale.requestId }
    val expired = sale.state == "PREPARED" && sale.expiresAt <= state.nowSeconds
    val accepted = sale.state == "ACCEPTED"
    val settled = sale.relayState == "SETTLED"
    BackHandler(onBack = model::dismissFocusedSale)
    Scaffold(containerColor = MaterialTheme.colorScheme.background) { padding ->
        Column(
            Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 12.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    when {
                        accepted -> "Payment accepted"
                        expired -> "Request expired"
                        else -> "Collect payment"
                    },
                    style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f).semantics { heading() },
                )
                IconButton(onClick = model::dismissFocusedSale) { Icon(Icons.Rounded.Close, "Close payment") }
            }
            Row(verticalAlignment = Alignment.Bottom) {
                Text(formatUnits(sale.grossUnits, CHANNEL_ASSET_DECIMALS), style = MaterialTheme.typography.displayMedium)
                Spacer(Modifier.width(8.dp))
                Text(CHANNEL_ASSET_SYMBOL, style = MaterialTheme.typography.titleLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(bottom = 8.dp))
            }
            // A typed amount has no name worth showing; a POS order shows what it is.
            order?.takeIf { !it.orderReference.startsWith("KP-") }?.let {
                Text(
                    "${it.description} · ${it.orderReference}",
                    style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            when {
                accepted -> {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(
                            if (settled) Icons.Rounded.CheckCircle else Icons.Rounded.DateRange, null,
                            tint = if (settled) TerminalColors.Mint else TerminalColors.Amber, modifier = Modifier.size(20.dp),
                        )
                        Spacer(Modifier.width(8.dp))
                        Text(
                            if (settled) "Paid and confirmed" else "Accepted · confirming once uploaded",
                            color = if (settled) TerminalColors.Mint else TerminalColors.Amber, style = MaterialTheme.typography.labelLarge,
                        )
                    }
                                        sale.receiptJson?.let { QrPanel(it, "Receipt", "The customer can scan this to keep a receipt.") }
                }
                expired -> {
                    EmptyCard(Icons.Rounded.Warning, "Nothing was charged", "The customer did not finish in time. Charge again to retry.")
                }
                else -> {
                    val left = sale.expiresAt - state.nowSeconds
                    StatusPill(
                        if (sale.state == "ATTENDEE_SIGNED") "Customer approved" else "Expires in ${countdown(left)}",
                        if (left <= 30) TerminalColors.Coral else TerminalColors.Amber, pulsing = true,
                    )
                    QrPanel(sale.requestQr, "1. Customer scans this code", "They check the amount and approve it on their phone.")
                }
            }

            if (state.error) MessageLine(state)

            val source = remember { MutableInteractionSource() }
            val (label, action) = when {
                accepted || expired -> "Done" to model::dismissFocusedSale
                sale.state == "ATTENDEE_SIGNED" -> "Finish payment" to { model.resumeAcceptance(sale.requestId); Unit }
                else -> "2. Scan customer's code" to { model.beginScan(sale.requestId) }
            }
            Button(
                onClick = { haptics.performHapticFeedback(HapticFeedbackType.LongPress); action() },
                enabled = !state.busy && (accepted || expired || state.trustedTime != null),
                interactionSource = source,
                shape = MaterialTheme.shapes.large,
                colors = ButtonDefaults.buttonColors(containerColor = TerminalColors.Mint, contentColor = TerminalColors.OnMint),
                contentPadding = PaddingValues(vertical = 18.dp),
                modifier = Modifier.fillMaxWidth().heightIn(min = 60.dp).scale(pressScale(source)),
            ) {
                if (sale.state == "PREPARED" && !expired) { ScanGlyph(20.dp, TerminalColors.OnMint); Spacer(Modifier.width(10.dp)) }
                Text(label, style = MaterialTheme.typography.titleMedium)
            }
            // Before the customer has answered nothing is held, so the cashier can simply start over.
            if (sale.state == "PREPARED" && !expired) {
                TextButton(onClick = { model.cancelSale(sale.requestId) }, enabled = !state.busy) {
                    Text("Cancel sale", color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
}

/**
 * The full screen for one online sale: the code for the customer to scan, then a plain status
 * until the money has arrived. The customer does everything on their own phone; the cashier only
 * shows the code and sees "Paid".
 */
@Composable
private fun OnlinePaymentScreen(sale: OnlineSaleView, state: TerminalUiState, model: TerminalViewModel) {
    val haptics = LocalHapticFeedback.current
    BackHandler(onBack = model::dismissFocusedSale)
    // A short buzz the moment the money has arrived, for a cashier who is watching the customer.
    LaunchedEffect(sale.state) {
        if (sale.state == "PAID") haptics.performHapticFeedback(HapticFeedbackType.LongPress)
    }
    val finished = !sale.active
    Scaffold(containerColor = MaterialTheme.colorScheme.background) { padding ->
        Column(
            Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 12.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    when (sale.state) {
                        "PAID" -> "Paid"
                        "WAITING" -> "Collect payment"
                        "CUSTOMER_PAYING", "SIGNED" -> "Customer is paying"
                        "DECLINED" -> "Payment not accepted"
                        "CANCELLED" -> "Sale cancelled"
                        else -> "Nothing was charged"
                    },
                    style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f).semantics { heading() },
                )
                IconButton(onClick = model::dismissFocusedSale) { Icon(Icons.Rounded.Close, "Close payment") }
            }
            Row(verticalAlignment = Alignment.Bottom) {
                Text(formatUnits(sale.grossUnits, sale.assetDecimals), style = MaterialTheme.typography.displayMedium)
                Spacer(Modifier.width(8.dp))
                Text(sale.assetSymbol, style = MaterialTheme.typography.titleLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(bottom = 8.dp))
            }
            when (sale.state) {
                "WAITING" -> {
                    val left = sale.expiresAt - state.nowSeconds
                    StatusPill("Expires in ${countdown(left)}", if (left <= 30) TerminalColors.Coral else TerminalColors.Amber, pulsing = true)
                    if (sale.checkoutUrl != null) {
                        QrPanel(sale.checkoutUrl, "Customer scans this code", "They sign in with their passkey and pay. This screen updates by itself.")
                    } else {
                        CircularProgressIndicator(color = TerminalColors.Mint)
                    }
                }
                "CUSTOMER_PAYING", "SIGNED" -> {
                    CircularProgressIndicator(color = TerminalColors.Mint, modifier = Modifier.padding(vertical = 24.dp))
                    Text("Waiting for the customer to approve on their phone", style = MaterialTheme.typography.bodyLarge, textAlign = TextAlign.Center)
                }
                "PAID" -> Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(vertical = 24.dp)) {
                    Icon(Icons.Rounded.CheckCircle, null, tint = TerminalColors.Mint, modifier = Modifier.size(56.dp))
                    Spacer(Modifier.width(12.dp))
                    Text("Payment received", style = MaterialTheme.typography.headlineSmall, color = TerminalColors.Mint)
                }
                "DECLINED" -> EmptyCard(Icons.Rounded.Warning, "This payment was not signed", "The request did not match this sale. Charge again.")
                "CANCELLED" -> EmptyCard(Icons.Rounded.Warning, "Nothing was charged", "You cancelled this sale.")
                else -> EmptyCard(Icons.Rounded.Warning, "Nothing was charged", "The customer did not finish in time. Charge again to retry.")
            }
            if (state.error) MessageLine(state)
            if (finished) {
                val source = remember { MutableInteractionSource() }
                Button(
                    onClick = { haptics.performHapticFeedback(HapticFeedbackType.LongPress); model.dismissFocusedSale() },
                    interactionSource = source,
                    shape = MaterialTheme.shapes.large,
                    colors = ButtonDefaults.buttonColors(containerColor = TerminalColors.Mint, contentColor = TerminalColors.OnMint),
                    contentPadding = PaddingValues(vertical = 18.dp),
                    modifier = Modifier.fillMaxWidth().heightIn(min = 60.dp).scale(pressScale(source)),
                ) { Text("Done", style = MaterialTheme.typography.titleMedium) }
            } else if (sale.state == "WAITING" || sale.state == "CUSTOMER_PAYING") {
                // Until this terminal has signed, nothing can be paid, so the cashier can start over.
                TextButton(onClick = { model.cancelOnlineSale(sale.orderId) }) {
                    Text("Cancel sale", color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
}

@Composable
private fun QrPanel(value: String, title: String, caption: String) {
    Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.fillMaxWidth()) {
        Box(
            Modifier.fillMaxWidth().aspectRatio(1f).clip(MaterialTheme.shapes.medium).background(Color.White).padding(14.dp),
            contentAlignment = Alignment.Center,
        ) { RequestQr(value, Modifier.fillMaxSize()) }
        Spacer(Modifier.height(10.dp))
        Text(title, style = MaterialTheme.typography.titleSmall)
        Text(caption, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun StateBadge(raw: String) {
    val (label, color) = when (raw) {
        "IMPORTED" -> "Ready" to TerminalColors.Mint
        "PREPARED" -> "Waiting" to TerminalColors.Amber
        "ATTENDEE_SIGNED" -> "Approved" to TerminalColors.Amber
        "PENDING" -> "Pending" to TerminalColors.Amber
        "PAYING" -> "Paying" to TerminalColors.Amber
        "SETTLED", "PAID" -> "Paid" to TerminalColors.Mint
        "MISSED" -> "Not paid" to TerminalColors.Muted
        else -> raw.lowercase().replaceFirstChar { it.uppercase() }.replace('_', ' ') to TerminalColors.Muted
    }
    Text(
        label, style = MaterialTheme.typography.labelMedium, color = color, fontWeight = FontWeight.SemiBold,
        modifier = Modifier.clip(CircleShape).background(color.copy(alpha = 0.13f)).padding(horizontal = 10.dp, vertical = 4.dp),
    )
}

@Composable
private fun Footer() {
    Text(
        "Sales taken offline are paid once uploaded.",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f),
        modifier = Modifier.fillMaxWidth().padding(vertical = 20.dp),
    )
}

// ---------------------------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------------------------

@Composable
private fun ScannerScreen(state: TerminalUiState, model: TerminalViewModel) {
    val context = LocalContext.current
    val cameraPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { allowed ->
        if (!allowed) model.cameraError(IllegalStateException("Allow the camera to scan codes"))
    }
    val enrollment = state.scanPurpose == "ENROLLMENT"
    val granted = context.checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
    Box(Modifier.fillMaxSize().background(Color.Black)) {
        if (granted) {
            QrScanner(Modifier.fillMaxSize(), model::scanned, model::cameraError)
            Viewfinder(Modifier.align(Alignment.Center))
        } else {
            Column(
                Modifier.align(Alignment.Center).padding(32.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                Box(Modifier.size(72.dp).clip(CircleShape).background(TerminalColors.Mint.copy(alpha = 0.14f)), contentAlignment = Alignment.Center) {
                    ScanGlyph(32.dp, TerminalColors.Mint)
                }
                Text("Camera access needed", style = MaterialTheme.typography.headlineSmall, color = Color.White)
                Text(
                    "The camera is used only to read ${if (enrollment) "the setup code" else "the customer's code"}. Nothing is recorded.",
                    style = MaterialTheme.typography.bodyMedium, color = Color.White.copy(alpha = 0.7f),
                )
                Button(
                    onClick = { cameraPermission.launch(Manifest.permission.CAMERA) },
                    shape = MaterialTheme.shapes.medium,
                    colors = ButtonDefaults.buttonColors(containerColor = TerminalColors.Mint, contentColor = TerminalColors.OnMint),
                    contentPadding = PaddingValues(horizontal = 28.dp, vertical = 16.dp),
                ) { Text("Allow camera", style = MaterialTheme.typography.titleMedium) }
            }
        }
        Column(
            Modifier.align(Alignment.TopCenter).fillMaxWidth()
                .background(Brush.verticalGradient(listOf(Color.Black.copy(alpha = 0.75f), Color.Transparent)))
                .safeDrawingPadding().padding(horizontal = 24.dp, vertical = 20.dp),
        ) {
            Text(if (enrollment) "Scan setup code" else "Scan customer's code", style = MaterialTheme.typography.headlineSmall, color = Color.White)
            Text(
                if (enrollment) "Point at the setup code from the organizer." else "Point at the code on the customer's phone.",
                style = MaterialTheme.typography.bodyMedium, color = Color.White.copy(alpha = 0.75f),
            )
        }
        val source = remember { MutableInteractionSource() }
        FilledTonalButton(
            onClick = model::cancelScan,
            interactionSource = source,
            shape = CircleShape,
            colors = ButtonDefaults.filledTonalButtonColors(containerColor = Color.White.copy(alpha = 0.16f), contentColor = Color.White),
            contentPadding = PaddingValues(horizontal = 28.dp, vertical = 16.dp),
            modifier = Modifier.align(Alignment.BottomCenter).safeDrawingPadding().padding(bottom = 28.dp).scale(pressScale(source)),
        ) {
            Icon(Icons.Rounded.Close, null, modifier = Modifier.size(20.dp))
            Spacer(Modifier.width(8.dp))
            Text("Cancel", style = MaterialTheme.typography.titleMedium)
        }
    }
}

@Composable
private fun Viewfinder(modifier: Modifier = Modifier) {
    val transition = rememberInfiniteTransition(label = "scanLine")
    val progress by transition.animateFloat(0.08f, 0.92f, infiniteRepeatable(tween(1_600), RepeatMode.Reverse), label = "scanLineY")
    Canvas(modifier.size(260.dp)) {
        val w = size.width
        val arm = w * 0.18f
        val stroke = 5.dp.toPx()
        val color = TerminalColors.Mint
        listOf(Offset(0f, 0f) to Offset(1f, 1f), Offset(w, 0f) to Offset(-1f, 1f), Offset(0f, w) to Offset(1f, -1f), Offset(w, w) to Offset(-1f, -1f))
            .forEach { (origin, direction) ->
                drawLine(color, origin, Offset(origin.x + direction.x * arm, origin.y), stroke, StrokeCap.Round)
                drawLine(color, origin, Offset(origin.x, origin.y + direction.y * arm), stroke, StrokeCap.Round)
            }
        drawLine(
            Brush.horizontalGradient(listOf(Color.Transparent, color, Color.Transparent)),
            Offset(w * 0.08f, w * progress), Offset(w * 0.92f, w * progress), 2.5.dp.toPx(), StrokeCap.Round,
        )
    }
}

// ---------------------------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------------------------

private fun formatUnits(units: String, decimals: Int): String = runCatching {
    BigDecimal(units).movePointLeft(decimals).setScale(minOf(2, decimals).coerceAtLeast(0), RoundingMode.DOWN).toPlainString()
}.getOrDefault(units)

private fun shortAddress(value: String): String =
    if (value.length > 14) "${value.take(6)}…${value.takeLast(4)}" else value

/** Time left, clamped at zero: "4:07" under an hour, "1:04:07" above it. */
private fun countdown(seconds: Long): String {
    val left = seconds.coerceAtLeast(0)
    return if (left >= 3_600) "%d:%02d:%02d".format(left / 3_600, left % 3_600 / 60, left % 60)
    else "%d:%02d".format(left / 60, left % 60)
}

private val clockFormat = DateTimeFormatter.ofPattern("HH:mm").withZone(ZoneId.systemDefault())

/** Formats an epoch timestamp in seconds, or milliseconds when it is clearly too large for seconds. */
private fun clock(epoch: Long): String = runCatching {
    val instant = if (epoch > 100_000_000_000L) Instant.ofEpochMilli(epoch) else Instant.ofEpochSecond(epoch)
    clockFormat.format(instant)
}.getOrDefault(epoch.toString())

/** Internal words a cashier should never have to read; a message containing one is replaced. */
private val TECHNICAL = Regex(
    "\\b(channel|voucher|vault|nonce|payload|signature|signer|sequence|finaliz\\w*|relay\\w*|provisioning|digest|snapshot|ciphertext|keystore|journal|exception|null|0x[0-9a-f]+)\\b",
    RegexOption.IGNORE_CASE,
)

/** Rewrites terse transport errors into something a cashier can act on; everything else passes through. */
private fun friendlyMessage(message: String): String = when {
    message.equals("timeout", true) || message.contains("timed out", true) -> "Network timed out. Check the connection and try again."
    message.contains("Unable to resolve host", true) || message.contains("failed to connect", true) ->
        "No internet connection. Connect and try again."
    message.contains("Refresh authenticated time", true) -> "Check the clock first."
    message.contains("Select a verified channel", true) -> "Choose a reserve first."
    message.contains("not installed", true) -> "Set up this terminal first."
    TECHNICAL.containsMatchIn(message) || message.length > 120 -> "That did not work. Try again, or ask the organizer."
    else -> message
}
