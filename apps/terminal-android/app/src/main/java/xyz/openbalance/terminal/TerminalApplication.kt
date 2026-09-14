package xyz.openbalance.terminal

import android.app.Application
import xyz.openbalance.terminal.data.TerminalDatabase
import xyz.openbalance.terminal.data.TerminalRepository
import xyz.openbalance.terminal.security.TerminalKeyStore

class TerminalApplication : Application() {
    val keys by lazy { TerminalKeyStore(this) }
    val database by lazy { TerminalDatabase.open(this) }
    val repository by lazy { TerminalRepository(database, keys) }
}
