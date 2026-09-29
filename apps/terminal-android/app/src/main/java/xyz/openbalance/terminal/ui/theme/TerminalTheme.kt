package xyz.openbalance.terminal.ui.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** Semantic colors the Material scheme has no slot for: money states need their own, fixed meaning. */
object TerminalColors {
    val Mint = Color(0xFF5EEAD4)
    val MintDeep = Color(0xFF0F766E)
    val Amber = Color(0xFFFBBF24)
    val Coral = Color(0xFFFB7185)
    val Ink = Color(0xFF070B10)
    val Surface1 = Color(0xFF0F151C)
    val Surface2 = Color(0xFF151D26)
    val Surface3 = Color(0xFF1C2631)
    val Outline = Color(0xFF263241)
    val Muted = Color(0xFF8A99AB)
}

// A fixed brand scheme rather than dynamic color: a payment terminal must look the same on every
// device so staff and attendees recognise it, and status colors must never be re-tinted by wallpaper.
private val scheme = darkColorScheme(
    primary = TerminalColors.Mint,
    onPrimary = Color(0xFF032621),
    primaryContainer = Color(0xFF0B3B35),
    onPrimaryContainer = Color(0xFFB9F6EA),
    secondary = Color(0xFF93C5FD),
    onSecondary = Color(0xFF0B2545),
    secondaryContainer = TerminalColors.Surface3,
    onSecondaryContainer = Color(0xFFE2E8F0),
    tertiary = TerminalColors.Amber,
    background = TerminalColors.Ink,
    onBackground = Color(0xFFF1F5F9),
    surface = TerminalColors.Ink,
    onSurface = Color(0xFFF1F5F9),
    surfaceVariant = TerminalColors.Surface2,
    onSurfaceVariant = TerminalColors.Muted,
    surfaceContainerLowest = TerminalColors.Ink,
    surfaceContainerLow = TerminalColors.Surface1,
    surfaceContainer = TerminalColors.Surface1,
    surfaceContainerHigh = TerminalColors.Surface2,
    surfaceContainerHighest = TerminalColors.Surface3,
    outline = TerminalColors.Outline,
    outlineVariant = Color(0xFF1A232E),
    error = TerminalColors.Coral,
    onError = Color(0xFF3B0712),
)

// Expressive scale: heavier display weights and tighter tracking for headline numbers, calmer body.
private val base = Typography()
private val typography = Typography(
    displaySmall = base.displaySmall.copy(fontWeight = FontWeight.SemiBold, letterSpacing = (-0.5).sp),
    headlineLarge = base.headlineLarge.copy(fontWeight = FontWeight.Bold, letterSpacing = (-0.5).sp),
    headlineMedium = base.headlineMedium.copy(fontWeight = FontWeight.Bold, letterSpacing = (-0.25).sp),
    titleLarge = base.titleLarge.copy(fontWeight = FontWeight.SemiBold),
    titleMedium = base.titleMedium.copy(fontWeight = FontWeight.SemiBold),
    labelLarge = base.labelLarge.copy(fontWeight = FontWeight.SemiBold, letterSpacing = 0.2.sp),
    bodyMedium = base.bodyMedium.copy(lineHeight = 20.sp),
)

val MonoSmall = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 12.sp, letterSpacing = 0.3.sp)

private val shapes = Shapes(
    extraSmall = RoundedCornerShape(8.dp),
    small = RoundedCornerShape(12.dp),
    medium = RoundedCornerShape(20.dp),
    large = RoundedCornerShape(28.dp),
    extraLarge = RoundedCornerShape(36.dp),
)

@Composable
fun TerminalTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = scheme, typography = typography, shapes = shapes, content = content)
}
