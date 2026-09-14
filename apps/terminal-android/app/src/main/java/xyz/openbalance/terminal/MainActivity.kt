package xyz.openbalance.terminal

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import xyz.openbalance.terminal.camera.QrScanner
import xyz.openbalance.terminal.camera.RequestQr
import xyz.openbalance.terminal.ui.TerminalViewModel

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        setContent { MaterialTheme(colorScheme = darkColorScheme(primary = Color(0xFF63E6BE))) { TerminalScreen() } }
    }
}

@Composable
private fun TerminalScreen(model: TerminalViewModel = viewModel()) {
    val state by model.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val cameraPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { allowed ->
        if (!allowed) model.cameraError(IllegalStateException("Camera permission is required for offline exchange"))
    }
    if (state.scanOpen) {
        Box(Modifier.fillMaxSize().background(Color.Black)) {
            if (context.checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                QrScanner(Modifier.fillMaxSize(), model::scanned, model::cameraError)
            } else {
                Column(Modifier.align(Alignment.Center).padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("Camera access is required to scan the attendee authorization.")
                    Button(onClick = { cameraPermission.launch(Manifest.permission.CAMERA) }) { Text("Allow camera") }
                }
            }
            Button(onClick = model::cancelScan, modifier = Modifier.align(Alignment.BottomCenter).padding(24.dp)) { Text("Cancel scan") }
        }
        return
    }

    Scaffold { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            item {
                Text("OpenBalance Terminal", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
                Text("Disconnected receipts stay pending until finalized onchain.", color = Color(0xFFB8CCC5))
                Spacer(Modifier.height(12.dp))
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(if (state.configured) "Terminal configured" else "Configuration required", fontWeight = FontWeight.Bold)
                        Text(state.signer.ifBlank { "Creating protected terminal identity" }, style = MaterialTheme.typography.bodySmall)
                        Text(state.message)
                        Button(onClick = model::refreshTime, enabled = state.configured && !state.busy) { Text("Refresh trusted time") }
                    }
                }
            }
            item { Text("Recoverable sales", style = MaterialTheme.typography.titleLarge) }
            if (state.sales.isEmpty()) item { Text("No locally prepared sales. Finalized channels and orders must be provisioned while connected.") }
            items(state.sales, key = { it.requestId }) { sale ->
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text(sale.requestId, fontWeight = FontWeight.SemiBold)
                            Text(sale.state)
                        }
                        Text("Channel ${sale.channelId.take(14)}…", style = MaterialTheme.typography.bodySmall)
                        if (sale.state == "PREPARED" || sale.state == "ATTENDEE_SIGNED") {
                            RequestQr(sale.requestQr, Modifier.fillMaxWidth().height(260.dp))
                            Text("Attendee scans this request, verifies the amount and vendor, then returns a signed response.")
                            Button(onClick = {
                                if (sale.state == "ATTENDEE_SIGNED") model.resumeAcceptance(sale.requestId)
                                else model.beginScan(sale.requestId)
                            }, enabled = state.trustedTime != null && !state.busy) {
                                Text(if (sale.state == "PREPARED") "Scan attendee response" else "Resume acceptance")
                            }
                        }
                        if (sale.state == "ACCEPTED") {
                            Text("Accepted pending settlement", color = Color(0xFFFFD166))
                            sale.receiptJson?.let { receipt ->
                                RequestQr(receipt, Modifier.fillMaxWidth().height(300.dp))
                                Text("Attendee: scan to retain your signed receipt.")
                            }
                        }
                    }
                }
            }
        }
    }
}
