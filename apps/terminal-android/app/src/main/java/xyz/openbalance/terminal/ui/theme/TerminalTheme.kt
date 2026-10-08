package xyz.openbalance.terminal.ui.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** Semantic colors the Material scheme has no slot for: money states need their own, fixed meaning. */
// Light palette shared with the web app. Status colors are the darker shades so text and icons in
// them keep at least 4.5:1 contrast on white, not just the tinted backgrounds.
object TerminalColors {
    /** Brand teal: primary actions and settled / positive money states. */
    val Mint = Color(0xFF0D9488)
    val MintDeep = Color(0xFF0F766E)
    /** Content placed on a Mint fill (buttons, brand mark). */
    val OnMint = Color(0xFFFFFFFF)
    val Amber = Color(0xFFB45309)
    val Coral = Color(0xFFBE123C)
    val Paper = Color(0xFFF5F7FA)
    val Surface1 = Color(0xFFFFFFFF)
    val Surface2 = Color(0xFFF1F5F9)
    val Surface3 = Color(0xFFE8EDF3)
    val Outline = Color(0xFFCBD5E1)
    val Muted = Color(0xFF5B6676)
    val Ink = Color(0xFF0B1220)
}

// A fixed brand scheme rather than dynamic color: a payment terminal must look the same on every
// device so staff and attendees recognise it, and status colors must never be re-tinted by wallpaper.
private val scheme = lightColorScheme(
    primary = TerminalColors.Mint,
    onPrimary = TerminalColors.OnMint,
    primaryContainer = Color(0xFFE6F6F4),
    onPrimaryContainer = TerminalColors.MintDeep,
    secondary = TerminalColors.MintDeep,
    onSecondary = Color(0xFFFFFFFF),
    secondaryContainer = TerminalColors.Surface3,
    onSecondaryContainer = TerminalColors.Ink,
    tertiary = TerminalColors.Amber,
    background = TerminalColors.Paper,
    onBackground = TerminalColors.Ink,
    surface = TerminalColors.Paper,
    onSurface = TerminalColors.Ink,
    surfaceVariant = TerminalColors.Surface2,
    onSurfaceVariant = TerminalColors.Muted,
    surfaceContainerLowest = Color(0xFFFFFFFF),
    surfaceContainerLow = TerminalColors.Surface1,
    surfaceContainer = TerminalColors.Surface1,
    surfaceContainerHigh = TerminalColors.Surface2,
    surfaceContainerHighest = TerminalColors.Surface3,
    outline = TerminalColors.Outline,
    outlineVariant = Color(0xFFE3E8EF),
    error = TerminalColors.Coral,
    onError = Color(0xFFFFFFFF),
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
