package xyz.openbalance.terminal.camera

import android.graphics.Bitmap
import androidx.compose.foundation.Image
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel

@Composable
fun RequestQr(value: String, modifier: Modifier = Modifier) {
    val bitmap = remember(value) { encodeQr(value) }
    Image(bitmap.asImageBitmap(), contentDescription = "Offline payment request QR", modifier = modifier)
}

private fun encodeQr(value: String): Bitmap {
    require(value.length <= 4_096) { "QR payload exceeds supported size" }
    val matrix = QRCodeWriter().encode(
        value,
        BarcodeFormat.QR_CODE,
        768,
        768,
        mapOf(EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M, EncodeHintType.MARGIN to 2),
    )
    return Bitmap.createBitmap(matrix.width, matrix.height, Bitmap.Config.ARGB_8888).also { bitmap ->
        val pixels = IntArray(matrix.width * matrix.height) { index ->
            if (matrix[index % matrix.width, index / matrix.width]) android.graphics.Color.BLACK else android.graphics.Color.WHITE
        }
        bitmap.setPixels(pixels, 0, matrix.width, 0, 0, matrix.width, matrix.height)
    }
}
