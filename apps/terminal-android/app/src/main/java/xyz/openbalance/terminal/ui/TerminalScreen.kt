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
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.material3.FilledTonalButton
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
                        colors = NavigationBarItemDefaults.colors(indicatorColor = TerminalColors.Mint.copy(alpha = 0.18f)),
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

/** Reserves still inside their accept window, latest-closing first. Expired ones stay on the Terminal tab. */
private fun usableChannels(state: TerminalUiState) =
    state.channels.filter { it.acceptUntil > state.nowSeconds }.sortedByDescending { it.acceptUntil }

/** A request the attendee can still answer. Expired ones hold nothing and are released on the next charge. */
private fun isLiveRequest(sale: SaleView, nowSeconds: Long) =
    (sale.state == "PREPARED" && sale.expiresAt > nowSeconds) || sale.state == "ATTENDEE_SIGNED"

@Composable
private fun CheckoutTab(state: TerminalUiState, model: TerminalViewModel, openTerminal: () -> Unit) {
    val orders = chargeableOrders(state)
    val live = state.sales.firstOrNull { isLiveRequest(it, state.nowSeconds) }
    var pickingReserve by remember { mutableStateOf(false) }
    TabList {
        item { TopBar(state) }
        item { ReadinessCard(state, model, onChangeReserve = { pickingReserve = true }, openTerminal = openTerminal) }
        if (state.pending.waitingCount > 0 || state.pending.needsAttentionCount > 0) {
            item(key = "pending") { PendingUploadBanner(state, model) }
        }
        live?.let { sale ->
            item(key = "live") { LivePaymentBanner(sale, state) { model.focusSale(sale.requestId) } }
        }
        item { SectionHeader("Orders", orders.size, "Ready to charge from the connected POS") }
        if (orders.isEmpty()) {
            item { EmptyCard(Icons.Rounded.ShoppingCart, "No orders waiting", "Synchronize while connected to import POS orders.") }
        }
        items(orders, key = { "order:${it.orderId}" }) { order -> OrderRow(order, state, model) }
        val hidden = state.orders.size - orders.size
        if (hidden > 0) {
            item {
                Text(
                    "$hidden charged or expired order${if (hidden == 1) "" else "s"} hidden · see Sales",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
                )
            }
        }
    }
    if (pickingReserve) ReservePicker(state, model) { pickingReserve = false }
}

@Composable
private fun SalesTab(state: TerminalUiState, model: TerminalViewModel) {
    val pending = state.sales.count { isPendingSale(it, state.nowSeconds) }
    val settled = state.sales.count { it.relayState == "SETTLED" }
    val haptics = LocalHapticFeedback.current
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
                Text("Upload receipts and check settlement", style = MaterialTheme.typography.labelLarge)
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
                        "with the venue relay, settling onchain",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        if (state.pending.missedCount > 0) {
            item {
                Text(
                    "${state.pending.missedCount} sale${if (state.pending.missedCount == 1) "" else "s"} missed the upload deadline · " +
                        "${formatUnits(state.pending.missedUnits.toString(), CHANNEL_ASSET_DECIMALS)} $CHANNEL_ASSET_SYMBOL " +
                        "will not be paid; the attendee gets it back",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        item { MessageLine(state) }
        if (state.sales.isEmpty()) {
            item { EmptyCard(Icons.AutoMirrored.Rounded.List, "No sales yet", "Accepted offline payments appear here until they settle onchain.") }
        }
        items(state.sales, key = { "sale:${it.requestId}" }) { sale ->
            SaleRow(sale, state) { model.focusSale(sale.requestId) }
        }
    }
}

@Composable
private fun TerminalTab(state: TerminalUiState, model: TerminalViewModel) {
    val enrolled = state.configured
    val timeReady = state.trustedTime != null
    TabList {
        item { TopBar(state) }
        item { StatusHero(state, enrolled, timeReady) }
        item { ActionDeck(state, model, enrolled, timeReady) }
        item { SectionHeader("Reserve channels", state.channels.size, "Finalized onchain, verified on this device") }
        if (state.channels.isEmpty()) {
            item { EmptyCard(Icons.Rounded.Lock, "No verified channels", "Attendee reserves assigned to this terminal appear after synchronizing.") }
        }
        items(state.channels, key = { "channel:${it.channelId}" }) { channel ->
            ChannelCard(channel, selected = state.selectedChannelId == channel.channelId, enabled = !state.busy) {
                model.selectChannel(channel.channelId)
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
private fun ReadinessCard(state: TerminalUiState, model: TerminalViewModel, onChangeReserve: () -> Unit, openTerminal: () -> Unit) {
    val haptics = LocalHapticFeedback.current
    val usable = usableChannels(state)
    val selected = usable.firstOrNull { it.channelId == state.selectedChannelId }
    val timeReady = state.trustedTime != null
    val ready = state.configured && timeReady && selected != null
    val (title, action) = when {
        !state.configured -> "Set up this terminal" to ("Open setup" to openTerminal)
        !timeReady -> "Trusted time needed" to ("Refresh trusted time" to { model.refreshTime(); Unit })
        usable.isEmpty() -> "Waiting for reserves" to ("Synchronize" to { model.synchronize(); Unit })
        selected == null -> "Choose a reserve" to ("Choose reserve" to onChangeReserve)
        else -> "Ready to charge" to null
    }
    Surface(
        shape = MaterialTheme.shapes.large,
        color = MaterialTheme.colorScheme.surfaceContainer,
        border = BorderStroke(1.dp, if (ready) TerminalColors.Mint.copy(alpha = 0.4f) else MaterialTheme.colorScheme.outlineVariant),
        modifier = Modifier.fillMaxWidth().animateContentSize(),
    ) {
        Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(title, style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f).semantics { heading() })
                val seconds = state.timeValidSeconds
                if (timeReady && seconds != null) {
                    StatusPill(
                        "Time ${countdown(seconds)}",
                        if (seconds <= 60) TerminalColors.Amber else TerminalColors.Mint,
                        pulsing = seconds <= 60,
                    )
                }
            }
            if (selected != null) {
                Row(
                    Modifier.fillMaxWidth().clip(MaterialTheme.shapes.medium)
                        .background(MaterialTheme.colorScheme.surfaceContainerHighest)
                        .clickable(enabled = !state.busy, role = Role.Button, onClickLabel = "Change reserve", onClick = onChangeReserve)
                        .padding(horizontal = 14.dp, vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(Icons.Rounded.Lock, null, tint = TerminalColors.Mint, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(10.dp))
                    Column(Modifier.weight(1f)) {
                        Text("${formatUnits(selected.remainingUnits, CHANNEL_ASSET_DECIMALS)} $CHANNEL_ASSET_SYMBOL reserve", style = MaterialTheme.typography.titleSmall)
                        Text(
                            "Up to ${formatUnits(selected.maxPerSaleUnits.toString(), CHANNEL_ASSET_DECIMALS)} per sale · " +
                                "${selected.salesLeft} sale${if (selected.salesLeft == 1L) "" else "s"} left",
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Text(shortAddress(selected.channelId), style = MonoSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    if (usable.size > 1) Text("Change", style = MaterialTheme.typography.labelLarge, color = TerminalColors.Mint)
                }
                // The reserve stops taking offline payments at acceptUntil; count down to it the way
                // trusted time is counted down, so a cashier is never surprised mid-queue.
                val left = selected.acceptUntil - state.nowSeconds
                StatusPill(
                    "Takes payments for ${countdown(left)} · until ${clock(selected.acceptUntil)}",
                    if (left <= RESERVE_CLOSING_SECONDS) TerminalColors.Amber else TerminalColors.Mint,
                    pulsing = left <= RESERVE_CLOSING_SECONDS,
                )
            }
            MessageLine(state)
            action?.let { (label, onClick) ->
                PrimaryAction(label, if (label == "Open setup" || label == "Choose reserve") null else Icons.Rounded.Refresh, enabled = !state.busy) {
                    haptics.performHapticFeedback(HapticFeedbackType.LongPress); onClick()
                }
            }
            AnimatedVisibility(state.busy, enter = expandVertically() + fadeIn(), exit = shrinkVertically() + fadeOut()) {
                LinearProgressIndicator(
                    modifier = Modifier.fillMaxWidth().height(4.dp).clip(CircleShape),
                    color = TerminalColors.Mint, trackColor = MaterialTheme.colorScheme.surfaceContainerHighest,
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ReservePicker(state: TerminalUiState, model: TerminalViewModel, onDismiss: () -> Unit) {
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheet, containerColor = MaterialTheme.colorScheme.surfaceContainer) {
        LazyColumn(
            contentPadding = PaddingValues(start = 20.dp, end = 20.dp, bottom = 28.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            item { Text("Charge against", style = MaterialTheme.typography.titleLarge, modifier = Modifier.semantics { heading() }) }
            items(usableChannels(state), key = { it.channelId }) { channel ->
                ChannelCard(channel, selected = state.selectedChannelId == channel.channelId, enabled = !state.busy) {
                    model.selectChannel(channel.channelId); onDismiss()
                }
            }
        }
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
                        "Upload before ${clock(uploadBy)} (${countdown(left)} left) to get paid. Connect, or bring the terminal to the venue relay."
                    },
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurface,
                )
            }
            if (pending.needsAttentionCount > 0) {
                Text(
                    "${pending.needsAttentionCount} sale${if (pending.needsAttentionCount == 1) " was" else "s were"} refused by the relay. Ask the organizer to check ${if (pending.needsAttentionCount == 1) "it" else "them"}.",
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
private fun TopBar(state: TerminalUiState) {
    Row(Modifier.fillMaxWidth().padding(top = 4.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        BrandMark()
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text("OpenBalance", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
            Text("Terminal", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        StatusPill(
            text = when {
                state.busy -> "Working"
                state.configured -> "Enrolled"
                else -> "Setup"
            },
            color = when {
                state.busy -> TerminalColors.Amber
                state.configured -> TerminalColors.Mint
                else -> TerminalColors.Muted
            },
            pulsing = state.busy,
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
            drawCircle(Color(0xFF032621), radius = size.minDimension * 0.30f, center = Offset(size.width * 0.38f, size.height / 2), style = stroke)
            drawCircle(Color(0xFF032621), radius = size.minDimension * 0.30f, center = Offset(size.width * 0.62f, size.height / 2), style = stroke)
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
    val ready = enrolled && timeReady && state.channels.isNotEmpty()
    val title = when {
        !enrolled -> "Set up this terminal"
        !timeReady -> "Trusted time needed"
        !state.synced && state.channels.isEmpty() -> "Synchronize to go live"
        state.channels.isEmpty() -> "Waiting for reserves"
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
                Text(
                    shortAddress(state.signer).ifBlank { "Creating protected terminal identity" },
                    style = MonoSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.semantics { contentDescription = "Terminal key ${state.signer}" },
                )
                Spacer(Modifier.height(18.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                    ReadinessStep("Enrolled", enrolled, Modifier.weight(1f))
                    ReadinessStep(state.timeValidSeconds?.takeIf { timeReady }?.let { "Time ${countdown(it)}" } ?: "Time", timeReady, Modifier.weight(1f))
                    ReadinessStep(if (state.channels.isEmpty()) "Reserves" else "${state.channels.size} reserve${if (state.channels.size == 1) "" else "s"}",
                        state.channels.isNotEmpty(), Modifier.weight(1f))
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
        !enrolled -> Triple("Scan enrollment QR", null, model::beginEnrollmentScan)
        !timeReady -> Triple("Refresh trusted time", Icons.Rounded.DateRange, { model.refreshTime(); Unit })
        else -> Triple("Synchronize", Icons.Rounded.Refresh, { model.synchronize(); Unit })
    }
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        PrimaryAction(primary.first, primary.second, enabled = !state.busy, onClick = act(primary.third))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
            if (enrolled && timeReady) {
                ChipAction("Time", Icons.Rounded.DateRange, !state.busy, act { model.refreshTime() })
            } else if (enrolled) {
                ChipAction("Sync", Icons.Rounded.Refresh, !state.busy, act { model.synchronize() })
            }
            ChipAction("Receipts", Icons.Rounded.Send, enrolled && !state.busy, act { model.synchronizeReceipts() })
            ChipAction(if (enrolled) "Re-enroll" else "Enroll", null, !state.busy, act(model::beginEnrollmentScan))
        }
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
            contentColor = Color(0xFF032621),
            disabledContainerColor = MaterialTheme.colorScheme.surfaceContainerHighest,
        ),
        modifier = Modifier.fillMaxWidth().heightIn(min = 64.dp).scale(pressScale(source)),
    ) {
        if (icon != null) Icon(icon, null, modifier = Modifier.size(22.dp)) else ScanGlyph(22.dp, Color(0xFF032621))
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

/** One compact row per order, like a POS ticket list: what, how much, and a single Charge action. */
@Composable
private fun OrderRow(order: OrderView, state: TerminalUiState, model: TerminalViewModel) {
    val haptics = LocalHapticFeedback.current
    val live = state.sales.any { isLiveRequest(it, state.nowSeconds) }
    val reserve = state.channels.firstOrNull { it.channelId == state.selectedChannelId }
    val block = reserve?.let { OfflineLimits.chargeBlock(BigInteger(order.grossUnits), it) }
    val canCharge = reserve != null && block == null && state.trustedTime != null && !state.busy && !live
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
                        },
                        style = MaterialTheme.typography.bodySmall, color = TerminalColors.Coral,
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
                colors = ButtonDefaults.buttonColors(containerColor = TerminalColors.Mint, contentColor = Color(0xFF032621)),
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
                    Text("$CHANNEL_ASSET_SYMBOL available", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(bottom = 3.dp))
                }
                Text(shortAddress(channel.channelId), style = MonoSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Column(horizontalAlignment = Alignment.End) {
                Text("Accepts until", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
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
                    listOfNotNull(order?.description, clock(sale.createdAt), sale.requestId.take(8)).joinToString(" · "),
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
                sale.lastUploadError?.let {
                    Text(it, color = TerminalColors.Coral, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
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
                listOfNotNull(order?.description, order?.orderReference).joinToString(" · ").ifBlank { sale.requestId.take(8) },
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
                            if (settled) "Finalized onchain" else "Accepted · settles when the relay submits it",
                            color = if (settled) TerminalColors.Mint else TerminalColors.Amber, style = MaterialTheme.typography.labelLarge,
                        )
                    }
                    sale.transactionHash?.let { Text("Tx ${shortAddress(it)}", style = MonoSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    sale.receiptJson?.let { QrPanel(it, "Receipt", "Attendee scans to keep their signed receipt.") }
                }
                expired -> {
                    EmptyCard(Icons.Rounded.Warning, "Nothing was charged", "The attendee did not answer in time. The reserve is released on the next charge.")
                }
                else -> {
                    val left = sale.expiresAt - state.nowSeconds
                    StatusPill(
                        if (sale.state == "ATTENDEE_SIGNED") "Response received" else "Expires in ${countdown(left)}",
                        if (left <= 30) TerminalColors.Coral else TerminalColors.Amber, pulsing = true,
                    )
                    QrPanel(sale.requestQr, "1. Attendee scans this code", "They check the amount and vendor, then show their signed response.")
                }
            }

            MessageLine(state)

            val source = remember { MutableInteractionSource() }
            val (label, action) = when {
                accepted || expired -> "Done" to model::dismissFocusedSale
                sale.state == "ATTENDEE_SIGNED" -> "Resume acceptance" to { model.resumeAcceptance(sale.requestId); Unit }
                else -> "2. Scan attendee response" to { model.beginScan(sale.requestId) }
            }
            Button(
                onClick = { haptics.performHapticFeedback(HapticFeedbackType.LongPress); action() },
                enabled = !state.busy && (accepted || expired || state.trustedTime != null),
                interactionSource = source,
                shape = MaterialTheme.shapes.large,
                colors = ButtonDefaults.buttonColors(containerColor = TerminalColors.Mint, contentColor = Color(0xFF032621)),
                contentPadding = PaddingValues(vertical = 18.dp),
                modifier = Modifier.fillMaxWidth().heightIn(min = 60.dp).scale(pressScale(source)),
            ) {
                if (sale.state == "PREPARED" && !expired) { ScanGlyph(20.dp, Color(0xFF032621)); Spacer(Modifier.width(10.dp)) }
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
        "PREPARED" -> "Awaiting attendee" to TerminalColors.Amber
        "ATTENDEE_SIGNED" -> "Signed" to TerminalColors.Amber
        "PENDING" -> "Pending" to TerminalColors.Amber
        "SETTLED" -> "Settled" to TerminalColors.Mint
        "MISSED" -> "Missed" to TerminalColors.Muted
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
        "Offline receipts stay pending until finalized onchain.",
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
        if (!allowed) model.cameraError(IllegalStateException("Camera permission is required for offline exchange"))
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
                    "The camera is used only to read ${if (enrollment) "the enrollment QR" else "the attendee's signed response"}. Nothing is recorded.",
                    style = MaterialTheme.typography.bodyMedium, color = Color.White.copy(alpha = 0.7f),
                )
                Button(
                    onClick = { cameraPermission.launch(Manifest.permission.CAMERA) },
                    shape = MaterialTheme.shapes.medium,
                    colors = ButtonDefaults.buttonColors(containerColor = TerminalColors.Mint, contentColor = Color(0xFF032621)),
                    contentPadding = PaddingValues(horizontal = 28.dp, vertical = 16.dp),
                ) { Text("Allow camera", style = MaterialTheme.typography.titleMedium) }
            }
        }
        Column(
            Modifier.align(Alignment.TopCenter).fillMaxWidth()
                .background(Brush.verticalGradient(listOf(Color.Black.copy(alpha = 0.75f), Color.Transparent)))
                .safeDrawingPadding().padding(horizontal = 24.dp, vertical = 20.dp),
        ) {
            Text(if (enrollment) "Scan enrollment" else "Scan attendee response", style = MaterialTheme.typography.headlineSmall, color = Color.White)
            Text(
                if (enrollment) "Point at the operator-issued terminal QR." else "Point at the signed QR on the attendee's phone.",
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

/** Rewrites terse transport errors into something a cashier can act on; everything else passes through. */
private fun friendlyMessage(message: String): String = when {
    message.equals("timeout", true) || message.contains("timed out", true) -> "Network timed out. Check the connection and try again."
    message.contains("Unable to resolve host", true) -> "No internet connection. Connect and try again."
    else -> message
}
