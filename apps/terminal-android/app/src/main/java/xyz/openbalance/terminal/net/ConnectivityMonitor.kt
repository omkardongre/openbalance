package xyz.openbalance.terminal.net

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Whether the phone has working internet right now. Android marks a network "validated" only after
 * it has actually reached the internet, so a Wi-Fi with no uplink counts as offline. The terminal
 * uses this to pick between an online sale (one scan, paid from the customer's balance) and an
 * offline sale (paid from the reserve the customer set aside).
 */
class ConnectivityMonitor(context: Context) {
    private val manager = context.applicationContext.getSystemService(ConnectivityManager::class.java)
    private val _online = MutableStateFlow(currentlyOnline())
    val online: StateFlow<Boolean> = _online.asStateFlow()

    init {
        runCatching {
            manager.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
                override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
                    _online.value = validated(capabilities)
                }

                override fun onLost(network: Network) {
                    _online.value = false
                }
            })
        }
    }

    private fun currentlyOnline(): Boolean = runCatching {
        manager.getNetworkCapabilities(manager.activeNetwork)?.let(::validated) ?: false
    }.getOrDefault(false)

    private fun validated(capabilities: NetworkCapabilities) =
        capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
            capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
}
