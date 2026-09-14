package xyz.openbalance.terminal.camera

import android.annotation.SuppressLint
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

@SuppressLint("UnsafeOptInUsageError")
@Composable
fun QrScanner(modifier: Modifier = Modifier, onValue: (String) -> Unit, onError: (Throwable) -> Unit) {
    val context = LocalContext.current
    val owner = LocalLifecycleOwner.current
    val executor = remember { Executors.newSingleThreadExecutor() }
    val delivered = remember { AtomicBoolean(false) }
    val scanner = remember {
        BarcodeScanning.getClient(
            BarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build(),
        )
    }
    val previewView = remember { PreviewView(context).apply { scaleType = PreviewView.ScaleType.FILL_CENTER } }
    val boundProvider = remember { AtomicReference<ProcessCameraProvider?>(null) }

    AndroidView(factory = { previewView }, modifier = modifier)
    DisposableEffect(owner) {
        val future = ProcessCameraProvider.getInstance(context)
        future.addListener({
            try {
                val provider = future.get()
                boundProvider.set(provider)
                val preview = Preview.Builder().build().also { it.surfaceProvider = previewView.surfaceProvider }
                val analysis = ImageAnalysis.Builder().setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build()
                analysis.setAnalyzer(executor) { proxy ->
                    val image = proxy.image
                    if (image == null || delivered.get()) {
                        proxy.close(); return@setAnalyzer
                    }
                    scanner.process(InputImage.fromMediaImage(image, proxy.imageInfo.rotationDegrees))
                        .addOnSuccessListener { values ->
                            values.firstNotNullOfOrNull { it.rawValue }?.let { value ->
                                if (delivered.compareAndSet(false, true)) onValue(value)
                            }
                        }
                        .addOnFailureListener(onError)
                        .addOnCompleteListener { proxy.close() }
                }
                provider.unbindAll()
                provider.bindToLifecycle(owner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
            } catch (error: Throwable) {
                onError(error)
            }
        }, ContextCompat.getMainExecutor(context))
        onDispose {
            boundProvider.getAndSet(null)?.unbindAll()
            scanner.close()
            executor.shutdown()
        }
    }
}
