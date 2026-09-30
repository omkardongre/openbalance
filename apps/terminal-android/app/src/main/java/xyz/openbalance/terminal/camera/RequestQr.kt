package xyz.openbalance.terminal.camera

import android.graphics.Bitmap
import androidx.compose.foundation.Image
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel

/**
 * Offline payment payloads produce high-version QR codes, so module edges must stay sharp: the
 * matrix is rendered at one pixel per module and scaled without interpolation. A fixed-size bitmap
 * scaled with bilinear filtering blurs adjacent modules together and makes the code unreadable.
 */
@Composable
fun RequestQr(value: String, modifier: Modifier = Modifier) {
    val bitmap = remember(value) { encodeQr(value) }
    Image(
        bitmap.asImageBitmap(),
        contentDescription = "Offline payment request QR",
        modifier = modifier,
        contentScale = ContentScale.Fit,
        filterQuality = FilterQuality.None,
    )
}

private fun encodeQr(value: String): Bitmap {
    require(value.length <= 4_096) { "QR payload exceeds supported size" }
    // A requested size of 0 yields the minimal matrix: exactly one pixel per module plus the margin.
    val matrix = QRCodeWriter().encode(
        value,
        BarcodeFormat.QR_CODE,
        0,
        0,
        mapOf(EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M, EncodeHintType.MARGIN to 4),
    )
    return Bitmap.createBitmap(matrix.width, matrix.height, Bitmap.Config.ARGB_8888).also { bitmap ->
        val pixels = IntArray(matrix.width * matrix.height) { index ->
            if (matrix[index % matrix.width, index / matrix.width]) android.graphics.Color.BLACK else android.graphics.Color.WHITE
        }
        bitmap.setPixels(pixels, 0, matrix.width, 0, 0, matrix.width, matrix.height)
    }
}
