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

private const val RESERVE_PAGE_SIZE = 10

/** A reserve this close to its acceptance deadline is flagged so the cashier can switch or sync. */
private const val RESERVE_CLOSING_SECONDS = 10 * 60L

/** Offline sales this close to their submission deadline must be uploaded now or they will not settle. */
private const val UPLOAD_URGENT_SECONDS = 5 * 60L

@Composable
fun TerminalScreen(model: TerminalViewModel = viewModel()) {
    val state by model.state.collectAsStateWithLifecycle()
    AnimatedContent(
        targetState = state.scanOpen,
        transitionSpec = { fadeIn(tween(220)) togetherWith fadeOut(tween(160)) },
        label = "scanner",
    ) { scanning ->
        val focused = state.focusedSaleId?.let { id -> state.sales.firstOrNull { it.requestId == id } }
        when {
            scanning -> ScannerScreen(state, model)
            // One payment owns the whole screen while it is live, as card terminals do: the cashier and
            // attendee see a single amount, a single code and a single next step.
            focused != null -> PaymentScreen(focused, state, model)
            else -> HomeScreen(state, model)
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Home: three destinations instead of one long scroll
// ---------------------------------------------------------------------------------------------

private enum class Tab(val label: String, val icon: ImageVector) {
    Checkout("Checkout", Icons.Rounded.ShoppingCart),
    Sales("Sales", Icons.AutoMirrored.Rounded.List),
    Terminal("Terminal", Icons.Rounded.Settings),
}

@Composable
private fun HomeScreen(state: TerminalUiState, model: TerminalViewModel) {
    // Checkout first: its readiness card routes to setup when the terminal is not enrolled yet.
    var tab by rememberSaveable { mutableStateOf(Tab.Checkout) }
    val pendingSales = state.sales.count { isPendingSale(it, state.nowSeconds) }
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
                Tab.Checkout -> CheckoutTab(state, model) { tab = Tab.Terminal }
                Tab.Sales -> SalesTab(state, model)
                Tab.Terminal -> TerminalTab(state, model)
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

/** A request the attendee can still answer. Expired ones hold nothing and are released on the next charge. */
private fun isLiveRequest(sale: SaleView, nowSeconds: Long) =
    (sale.state == "PREPARED" && sale.expiresAt > nowSeconds) || sale.state == "ATTENDEE_SIGNED"

@Composable
private fun CheckoutTab(state: TerminalUiState, model: TerminalViewModel, openTerminal: () -> Unit) {
    val orders = chargeableOrders(state)
    val live = state.sales.firstOrNull { isLiveRequest(it, state.nowSeconds) }
    TabList {
        item { TopBar(state, model) }
        item { ReadinessCard(state, model, openTerminal = openTerminal) }
        if (state.pending.waitingCount > 0 || state.pending.needsAttentionCount > 0) {
            item(key = "pending") { PendingUploadBanner(state, model) }
        }
        live?.let { sale ->
            item(key = "live") { LivePaymentBanner(sale, state) { model.focusSale(sale.requestId) } }
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

@Composable
private fun SalesTab(state: TerminalUiState, model: TerminalViewModel) {
    val pending = state.sales.count { isPendingSale(it, state.nowSeconds) }
    val settled = state.sales.count { it.relayState == "SETTLED" }
    val haptics = LocalHapticFeedback.current
    var filter by rememberSaveable { mutableStateOf(SaleFilter.All) }
    TabList {
        item {
            Text("Sales", style = MaterialTheme.typography.headlineSmall, modifier = Modifier.padding(top = 4.dp).semantics { heading() })
        }
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                SummaryTile("Pending", pending, TerminalColors.Amber, Modifier.weight(1f))
                SummaryTile("Settled", settled, TerminalColors.Mint, Modifier.weight(1f))
            }
        }
        item {
            FilledTonalButton(
                onClick = { haptics.performHapticFeedback(HapticFeedbackType.LongPress); model.synchronizeReceipts() },
                enabled = state.configured && !state.busy,
                shape = MaterialTheme.shapes.medium,
                contentPadding = PaddingValues(vertical = 14.dp),
                modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp),
            ) {
                Icon(Icons.Rounded.Send, null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp))
                Text("Upload sales", style = MaterialTheme.typography.labelLarge)
            }
        }
        if (state.pending.waitingCount > 0 || state.pending.needsAttentionCount > 0) {
            item(key = "pending") { PendingUploadBanner(state, model) }
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
        if (state.pending.missedCount > 0) {
            item {
                Text(
                    "${state.pending.missedCount} sale${if (state.pending.missedCount == 1) "" else "s"} " +
                        "(${formatUnits(state.pending.missedUnits.toString(), CHANNEL_ASSET_DECIMALS)} $CHANNEL_ASSET_SYMBOL) " +
                        "were not uploaded in time and will not be paid. The customer gets the money back.",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        item { MessageLine(state) }
        item(key = "filters") {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                SaleFilter.entries.forEach { entry ->
                    val count = state.sales.count { entry.matches(it, state.nowSeconds) }
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
        val shown = state.sales.filter { filter.matches(it, state.nowSeconds) }
        if (shown.isEmpty()) {
            item {
                EmptyCard(
                    Icons.AutoMirrored.Rounded.List,
                    if (state.sales.isEmpty()) "No sales yet" else "No ${filter.label.lowercase()} sales",
                    if (state.sales.isEmpty()) "Payments you take appear here."
                    else "Try another filter, or load older sales below.",
                )
            }
        }
        items(shown, key = { "sale:${it.requestId}" }) { sale ->
            SaleRow(sale, state) { model.focusSale(sale.requestId) }
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
        } else if (state.sales.isNotEmpty()) {
            item(key = "end") {
                Text(
                    "${state.sales.size} sale${if (state.sales.size == 1) "" else "s"} on this terminal",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
                )
            }
        }
    }
}

private enum class SaleFilter(val label: String) {
    All("All"), Pending("Pending"), Settled("Settled"), Other("Not paid");

    fun matches(sale: SaleView, nowSeconds: Long) = when (this) {
        All -> true
        Pending -> isPendingSale(sale, nowSeconds) || isLiveRequest(sale, nowSeconds)
        Settled -> sale.relayState == "SETTLED"
        Other -> !isPendingSale(sale, nowSeconds) && !isLiveRequest(sale, nowSeconds) && sale.relayState != "SETTLED"
    }
}

@Composable
private fun TerminalTab(state: TerminalUiState, model: TerminalViewModel) {
    val enrolled = state.configured
    val timeReady = state.trustedTime != null
    var showClosed by rememberSaveable { mutableStateOf(false) }
    var visible by rememberSaveable { mutableStateOf(RESERVE_PAGE_SIZE) }
    TabList {
        item { TopBar(state, model) }
        item { StatusHero(state, enrolled, timeReady) }
        item { ActionDeck(state, model, enrolled, timeReady) }
        val open = usableChannels(state)
        val closed = state.channels.filterNot { it.isChargeable(state.nowSeconds) }.sortedByDescending { it.acceptUntil }
        val list = if (showClosed) closed else open
        item { SectionHeader("Reserves", open.size, "Money customers set aside to pay this stall") }
        item(key = "reserveFilter") {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf(false to "Open ${open.size}", true to "Closed ${closed.size}").forEach { (value, label) ->
                    FilterChip(
                        selected = showClosed == value,
                        onClick = { showClosed = value; visible = RESERVE_PAGE_SIZE },
                        label = { Text(label) },
                        colors = FilterChipDefaults.filterChipColors(
                            selectedContainerColor = TerminalColors.Mint.copy(alpha = 0.18f),
                            selectedLabelColor = TerminalColors.MintDeep,
                        ),
                    )
                }
            }
        }
        if (list.isEmpty()) {
            item {
                if (showClosed) EmptyCard(Icons.Rounded.Lock, "No closed reserves", "Spent or expired reserves are listed here.")
                else EmptyCard(Icons.Rounded.Lock, "No open reserves", "Money customers set aside for this stall appears after you tap Refresh.")
            }
        }
        items(list.take(visible), key = { "channel:${it.channelId}" }) { channel ->
            // Informational: the customer's phone picks which of its reserves pays.
            ChannelCard(channel, selected = false, enabled = false) {}
        }
        if (list.size > visible) {
            item(key = "moreReserves") {
                OutlinedButton(
                    onClick = { visible += RESERVE_PAGE_SIZE },
                    shape = MaterialTheme.shapes.medium,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                ) { Text("Show ${minOf(RESERVE_PAGE_SIZE, list.size - visible)} more") }
            }
        }
        item { Footer() }
    }
}

/**
 * The one card a cashier needs before charging: can I take a payment right now, for how long, and
 * against which reserve. Everything else lives on the Terminal tab.
 */
@Composable
private fun ReadinessCard(state: TerminalUiState, model: TerminalViewModel, openTerminal: () -> Unit) {
    val haptics = LocalHapticFeedback.current
    val usable = usableChannels(state)
    val timeReady = state.trustedTime != null
    val ready = state.configured && !state.pairing && timeReady && usable.isNotEmpty()
    var details by rememberSaveable { mutableStateOf(false) }
    val (title, action) = when {
        !state.configured -> "Set up this terminal" to ("Start setup" to openTerminal)
        state.pairing -> "Waiting for approval" to ("Check again" to { model.synchronize(); Unit })
        // The clock is checked by itself while online; a button appears only when that failed.
        !timeReady && state.clockFailed -> "Connect to the internet" to ("Try again" to { model.refreshTime(); Unit })
        !timeReady -> "Getting the time…" to null
        usable.isEmpty() && state.channels.any { it.acceptUntil > state.nowSeconds } ->
            "Reserves used up" to ("Refresh for new reserves" to { model.synchronize(); Unit })
        usable.isEmpty() -> "Waiting for reserves" to ("Refresh" to { model.synchronize(); Unit })
        else -> "Ready to charge" to null
    }
    val subtitle = when {
        !state.configured -> "Scan the setup code from the stall owner or organizer."
        state.pairing -> "The organizer still has to approve this phone."
        !timeReady && state.clockFailed -> "The phone needs the internet once to check the time before selling."
        !timeReady -> "This takes a few seconds."
        usable.isEmpty() -> "No open reserves right now. One appears when a customer sets money aside for this stall."
        else -> null
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
                if (ready) {
                    TextButton(onClick = { details = !details }) { Text(if (details) "Hide details" else "Details") }
                }
            }
            subtitle?.let {
                Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (ready) {
                Text(
                    "${usable.size} customer${if (usable.size == 1) "" else "s"} can pay offline",
                    style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                AnimatedVisibility(details, enter = expandVertically() + fadeIn(), exit = shrinkVertically() + fadeOut()) {
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        DetailLine(
                            "Most one customer can pay",
                            "${formatUnits(OfflineLimits.bestCover(usable).toString(), CHANNEL_ASSET_DECIMALS)} $CHANNEL_ASSET_SYMBOL",
                        )
                        usable.minOfOrNull { it.acceptUntil }?.let { DetailLine("First reserve closes at", clock(it)) }
                    }
                }
            }
            // Errors always show; routine progress only appears in Details.
            if (state.error) MessageLine(state)
            action?.let { (label, onClick) ->
                PrimaryAction(label, if (label == "Start setup" || label == "Choose reserve") null else Icons.Rounded.Refresh, enabled = !state.busy) {
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

@Composable
private fun DetailLine(label: String, value: String) {
    Row(Modifier.fillMaxWidth()) {
        Text(label, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
        Text(value, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurface)
    }
}

@Composable
private fun LivePaymentBanner(sale: SaleView, state: TerminalUiState, onOpen: () -> Unit) {
    Surface(
        shape = MaterialTheme.shapes.medium,
        color = TerminalColors.Amber.copy(alpha = 0.12f),
        border = BorderStroke(1.dp, TerminalColors.Amber.copy(alpha = 0.5f)),
        modifier = Modifier.fillMaxWidth().clip(MaterialTheme.shapes.medium)
            .clickable(role = Role.Button, onClickLabel = "Open payment", onClick = onOpen),
    ) {
        Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Payment in progress", style = MaterialTheme.typography.titleSmall, color = TerminalColors.Amber)
                Text(
                    "${formatUnits(sale.grossUnits, CHANNEL_ASSET_DECIMALS)} $CHANNEL_ASSET_SYMBOL · " +
                        if (sale.state == "ATTENDEE_SIGNED") "response received" else "expires in ${countdown(sale.expiresAt - state.nowSeconds)}",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurface,
                )
            }
            Text("Open", style = MaterialTheme.typography.labelLarge, color = TerminalColors.Amber)
        }
    }
}

/**
 * Offline sales still on this device. They are paid only once they reach the chain before their
 * reserve's submission deadline, so the warning names the deadline and escalates as it nears.
 */
@Composable
private fun PendingUploadBanner(state: TerminalUiState, model: TerminalViewModel) {
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
                        "The upload deadline passed at ${clock(uploadBy)}. Upload now; anything that misses its deadline will not be paid."
                    } else {
                        "Upload before ${clock(uploadBy)} (${countdown(left)} left) to get paid. Connect to the internet and tap Upload now."
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
            if (pending.waitingCount > 0) {
                FilledTonalButton(
                    onClick = { haptics.performHapticFeedback(HapticFeedbackType.LongPress); model.synchronizeReceipts() },
                    enabled = state.configured && !state.busy,
                    shape = MaterialTheme.shapes.medium,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                ) {
                    Icon(Icons.Rounded.Send, null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text("Upload now", style = MaterialTheme.typography.labelLarge)
                }
            }
        }
    }
}

@Composable
private fun SummaryTile(label: String, count: Int, color: Color, modifier: Modifier = Modifier) {
    Column(
        modifier.clip(MaterialTheme.shapes.medium).background(color.copy(alpha = 0.10f))
            .padding(horizontal = 16.dp, vertical = 12.dp)
            .semantics(mergeDescendants = true) { contentDescription = "$count $label" },
    ) {
        Text("$count", style = MaterialTheme.typography.headlineSmall, color = color)
        Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
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

        StatusPill(
            text = when {
                state.busy -> "Working"
                state.configured -> "Set up"
                else -> "Setup"
            },
            color = when {
                state.busy -> TerminalColors.Amber
                state.configured -> TerminalColors.Mint
                else -> TerminalColors.Muted
            },
            pulsing = state.busy,
        )
        // The one place the setup steps point to, on every tab: "Tap ⋮, then Scan setup code".
        Box {
            IconButton(onClick = { menuOpen = true }, enabled = !state.busy) {
                Icon(Icons.Rounded.MoreVert, contentDescription = "More options")
            }
            DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
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
private fun StatusHero(state: TerminalUiState, enrolled: Boolean, timeReady: Boolean) {
    val openCount = state.channels.count { it.isChargeable(state.nowSeconds) }
    val ready = enrolled && timeReady && openCount > 0
    val title = when {
        !enrolled -> "Set up this terminal"
        state.pairing -> "Waiting for approval"
        !timeReady -> "Clock check needed"
        !state.synced && state.channels.isEmpty() -> "Tap Refresh to go live"
        openCount == 0 -> "Waiting for reserves"
        else -> "Ready for offline payments"
    }
    Surface(
        shape = MaterialTheme.shapes.large,
        color = MaterialTheme.colorScheme.surfaceContainer,
        border = BorderStroke(1.dp, if (ready) TerminalColors.Mint.copy(alpha = 0.35f) else MaterialTheme.colorScheme.outlineVariant),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Box {
            // Soft glow in the corner; brighter once the terminal can take payments.
            val glow by animateFloatAsState(if (ready) 0.22f else 0.10f, spring(stiffness = Spring.StiffnessVeryLow), label = "glow")
            Box(
                Modifier.matchParentSize().background(
                    Brush.radialGradient(
                        listOf(TerminalColors.Mint.copy(alpha = glow), Color.Transparent),
                        center = Offset(900f, 0f), radius = 900f,
                    ),
                ),
            )
            Column(Modifier.padding(20.dp).animateContentSize(spring(stiffness = Spring.StiffnessMediumLow))) {
                AnimatedContent(targetState = title, label = "heroTitle",
                    transitionSpec = { fadeIn(tween(200)) togetherWith fadeOut(tween(120)) }) { value ->
                    Text(value, style = MaterialTheme.typography.headlineMedium, modifier = Modifier.semantics { heading() })
                }
                Spacer(Modifier.height(4.dp))
                Spacer(Modifier.height(18.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                    ReadinessStep("Set up", enrolled, Modifier.weight(1f))
                    ReadinessStep("Clock", timeReady, Modifier.weight(1f))
                    ReadinessStep(if (openCount == 0) "Reserves" else "$openCount open",
                        openCount > 0, Modifier.weight(1f))
                }
                Spacer(Modifier.height(16.dp))
                MessageLine(state)
                AnimatedVisibility(state.busy, enter = expandVertically() + fadeIn(), exit = shrinkVertically() + fadeOut()) {
                    LinearProgressIndicator(
                        modifier = Modifier.fillMaxWidth().padding(top = 12.dp).height(4.dp).clip(CircleShape),
                        color = TerminalColors.Mint, trackColor = MaterialTheme.colorScheme.surfaceContainerHighest,
                    )
                }
            }
        }
    }
}

@Composable
private fun ReadinessStep(label: String, done: Boolean, modifier: Modifier = Modifier) {
    val background by animateColorAsState(
        if (done) TerminalColors.Mint.copy(alpha = 0.14f) else MaterialTheme.colorScheme.surfaceContainerHighest,
        spring(stiffness = Spring.StiffnessMediumLow), label = "stepBg",
    )
    val content by animateColorAsState(
        if (done) TerminalColors.Mint else MaterialTheme.colorScheme.onSurfaceVariant,
        spring(stiffness = Spring.StiffnessMediumLow), label = "stepFg",
    )
    Row(
        modifier.clip(MaterialTheme.shapes.small).background(background).padding(horizontal = 10.dp, vertical = 10.dp)
            .semantics(mergeDescendants = true) { contentDescription = "$label ${if (done) "complete" else "pending"}" },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (done) Icon(Icons.Rounded.CheckCircle, null, tint = content, modifier = Modifier.size(16.dp))
        else Box(Modifier.size(16.dp).border(1.5.dp, content, CircleShape))
        Spacer(Modifier.width(6.dp))
        Text(label, style = MaterialTheme.typography.labelMedium, color = content, maxLines = 1, overflow = TextOverflow.Ellipsis)
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

@Composable
private fun ActionDeck(state: TerminalUiState, model: TerminalViewModel, enrolled: Boolean, timeReady: Boolean) {
    val haptics = LocalHapticFeedback.current
    val act: (() -> Unit) -> () -> Unit = { action -> { haptics.performHapticFeedback(HapticFeedbackType.LongPress); action() } }
    // The single most useful next step is promoted to a large primary button; everything else stays
    // one tap away as a compact tonal action.
    val primary: Triple<String, ImageVector?, () -> Unit> = when {
        !enrolled -> Triple("Scan setup code", null, model::beginEnrollmentScan)
        state.pairing -> Triple("Check again", Icons.Rounded.Refresh, { model.synchronize(); Unit })
        // The clock syncs by itself while online; a retry appears only when that failed.
        !timeReady && state.clockFailed -> Triple("Try again", Icons.Rounded.Refresh, { model.refreshTime(); Unit })
        else -> Triple("Refresh", Icons.Rounded.Refresh, { model.synchronize(); Unit })
    }
    var confirmReenroll by remember { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        PrimaryAction(primary.first, primary.second, enabled = !state.busy, onClick = act(primary.third))
        if (enrolled) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                if (primary.first != "Refresh") {
                    ChipAction("Refresh", Icons.Rounded.Refresh, !state.busy, act { model.synchronize() })
                }
                ChipAction("Upload sales", Icons.Rounded.Send, !state.busy, act { model.synchronizeReceipts() })
            }
            // A real (outlined) button, quieter than Refresh / Upload sales but clearly tappable.
            OutlinedButton(
                onClick = { confirmReenroll = true },
                enabled = !state.busy,
                shape = MaterialTheme.shapes.extraLarge,
                border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline),
                contentPadding = PaddingValues(horizontal = 20.dp, vertical = 14.dp),
                modifier = Modifier.fillMaxWidth(),
            ) {
                ScanGlyph(18.dp, MaterialTheme.colorScheme.onSurface)
                Spacer(Modifier.width(10.dp))
                Text("Scan a new setup code", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurface)
            }
        }
    }
    if (confirmReenroll) {
        AlertDialog(
            onDismissRequest = { confirmReenroll = false },
            title = { Text("Set up this terminal again?") },
            text = { Text("Scan the setup code for your stall. Your sales stay on this phone.") },
            confirmButton = {
                TextButton(onClick = { confirmReenroll = false; model.beginEnrollmentScan() }) { Text("Scan code") }
            },
            dismissButton = { TextButton(onClick = { confirmReenroll = false }) { Text("Cancel") } },
        )
    }
}

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

@Composable
private fun RowScope.ChipAction(label: String, icon: ImageVector?, enabled: Boolean, onClick: () -> Unit) {
    val source = remember { MutableInteractionSource() }
    FilledTonalButton(
        onClick = onClick,
        enabled = enabled,
        interactionSource = source,
        shape = MaterialTheme.shapes.medium,
        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 12.dp),
        modifier = Modifier.weight(1f).heightIn(min = 52.dp).scale(pressScale(source)),
    ) {
        if (icon != null) Icon(icon, null, modifier = Modifier.size(18.dp)) else ScanGlyph(18.dp, MaterialTheme.colorScheme.onSecondaryContainer)
        Spacer(Modifier.width(6.dp))
        Text(label, style = MaterialTheme.typography.labelLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
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
    val block = if (cents > 0 && reserves.isNotEmpty()) OfflineLimits.chargeBlock(units, reserves) else null
    val live = state.sales.any { isLiveRequest(it, state.nowSeconds) }
    val canCharge = cents > 0 && reserves.isNotEmpty() && block == null && state.vendor != null &&
        state.trustedTime != null && !state.busy && !live
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
private fun ChannelCard(channel: ChannelView, selected: Boolean, enabled: Boolean, onSelect: () -> Unit) {
    val border by animateColorAsState(
        if (selected) TerminalColors.Mint else MaterialTheme.colorScheme.outlineVariant,
        spring(stiffness = Spring.StiffnessMediumLow), label = "channelBorder",
    )
    val source = remember { MutableInteractionSource() }
    Surface(
        shape = MaterialTheme.shapes.medium,
        color = if (selected) TerminalColors.Mint.copy(alpha = 0.07f) else MaterialTheme.colorScheme.surfaceContainerLow,
        border = BorderStroke(if (selected) 1.5.dp else 1.dp, border),
        modifier = Modifier.fillMaxWidth().scale(pressScale(source))
            .clip(MaterialTheme.shapes.medium)
            .selectable(selected = selected, enabled = enabled, role = Role.RadioButton, interactionSource = source, indication = null, onClick = onSelect),
    ) {
        Row(Modifier.padding(18.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(
                Modifier.size(22.dp).clip(CircleShape).border(2.dp, border, CircleShape),
                contentAlignment = Alignment.Center,
            ) { if (selected) Box(Modifier.size(11.dp).clip(CircleShape).background(TerminalColors.Mint)) }
            Spacer(Modifier.width(14.dp))
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.Bottom) {
                    Text(formatUnits(channel.remainingUnits, CHANNEL_ASSET_DECIMALS), style = MaterialTheme.typography.titleLarge)
                    Spacer(Modifier.width(6.dp))
                    Text("$CHANNEL_ASSET_SYMBOL left", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(bottom = 3.dp))
                }
            }
            Column(horizontalAlignment = Alignment.End) {
                Text("Open until", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(clock(channel.acceptUntil), style = MaterialTheme.typography.labelLarge)
            }
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
                sale.lastUploadError?.let {
                    Text("Upload failed. It will retry", color = TerminalColors.Coral, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            Spacer(Modifier.width(12.dp))
            StateBadge(saleBadge(sale, state.nowSeconds))
        }
    }
}

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
            Text(
                listOfNotNull(order?.description, order?.orderReference).joinToString(" · ").ifBlank { "Sale at ${clock(sale.createdAt)}" },
                style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

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

            MessageLine(state)

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
        "SETTLED" -> "Settled" to TerminalColors.Mint
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
