package xyz.openbalance.terminal

import android.app.Application
import xyz.openbalance.terminal.data.TerminalDatabase
import xyz.openbalance.terminal.data.TerminalRepository
import xyz.openbalance.terminal.security.TerminalKeyStore
import xyz.openbalance.terminal.provisioning.ProvisioningStore
import xyz.openbalance.terminal.relay.RelayUploadClient
import xyz.openbalance.terminal.relay.RelayUploadWorker

class TerminalApplication : Application() {
    val keys by lazy { TerminalKeyStore(this) }
    val database by lazy { TerminalDatabase.open(this) }
    val repository by lazy { TerminalRepository(database, keys) }
    val provisioning by lazy { ProvisioningStore(this) }
    val relay by lazy { RelayUploadClient(repository, keys) }

    override fun onCreate() {
        super.onCreate()
        RelayUploadWorker.enqueue(this)
    }

    fun scheduleRelay() = RelayUploadWorker.enqueue(this)
}
