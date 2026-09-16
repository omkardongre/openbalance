package xyz.openbalance.terminal.relay

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import xyz.openbalance.terminal.TerminalApplication
import java.util.concurrent.TimeUnit

class RelayUploadWorker(context: Context, parameters: WorkerParameters) : CoroutineWorker(context, parameters) {
    override suspend fun doWork(): Result {
        val app = applicationContext as TerminalApplication
        return try {
            val config = app.provisioning.current() ?: return Result.success()
            repeat(MAX_BATCHES) {
                val result = app.relay.runBatch(config, BATCH_SIZE)
                if (result.uploaded + result.settled + result.retried + result.quarantined == 0)
                    return if (app.repository.pendingRelayCount() > 0) Result.retry() else Result.success()
            }
            if (app.repository.pendingRelayCount() > 0) Result.retry() else Result.success()
        } catch (_: Exception) {
            Result.retry()
        }
    }

    companion object {
        private const val UNIQUE_WORK = "openbalance-terminal-relay"
        private const val BATCH_SIZE = 20
        private const val MAX_BATCHES = 5

        fun enqueue(context: Context) {
            val constraints = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
            val request = OneTimeWorkRequestBuilder<RelayUploadWorker>()
                .setConstraints(constraints)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 10, TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork(UNIQUE_WORK, ExistingWorkPolicy.KEEP, request)
        }
    }
}
