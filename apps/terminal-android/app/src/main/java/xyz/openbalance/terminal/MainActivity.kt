package xyz.openbalance.terminal

import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import xyz.openbalance.terminal.ui.TerminalScreen
import xyz.openbalance.terminal.ui.theme.TerminalTheme
import android.graphics.Color as AndroidColor

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        // Edge-to-edge with light system-bar icons over the app's dark surface; Scaffold and the
        // scanner apply the insets so content never sits under the status or navigation bar.
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(AndroidColor.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(AndroidColor.TRANSPARENT),
        )
        super.onCreate(savedInstanceState)
        // Release builds keep payment screens out of screenshots, recordings and the recents preview.
        // Debug builds allow capture so device testing and demo filming can record the screen.
        if (!BuildConfig.DEBUG) window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        setContent { TerminalTheme { TerminalScreen() } }
    }
}
