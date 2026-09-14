package xyz.openbalance.terminal.data

import android.content.Context
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.Index
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

@Entity(tableName = "channels")
data class ChannelEntity(
    @PrimaryKey val channelId: String,
    val snapshotJson: String,
    val snapshotHash: String,
    val finalizedProofHash: String,
    val nextSequence: Long,
    val spentUnits: String,
    val lastVoucherDigest: String,
    val installedAt: Long,
    val updatedAt: Long,
)

@Entity(tableName = "sales", indices = [Index(value = ["channelId", "sequence"], unique = true), Index(value = ["paymentId"], unique = true)])
data class SaleEntity(
    @PrimaryKey val requestId: String,
    val channelId: String,
    val sequence: Long,
    val paymentId: String,
    val state: String,
    val payloadNonce: ByteArray,
    val payloadCiphertext: ByteArray,
    val createdAt: Long,
    val updatedAt: Long,
)

@Entity(
    tableName = "orders",
    indices = [Index(value = ["orderRefHash", "orderVersion"], unique = true), Index(value = ["requestId"], unique = true)],
)
data class OrderEntity(
    @PrimaryKey val orderId: String,
    val orderRefHash: String,
    val orderVersion: String,
    val grossUnits: String,
    val receiptCommitment: String,
    val expiresAt: Long,
    val state: String,
    val payloadNonce: ByteArray,
    val payloadCiphertext: ByteArray,
    val requestId: String?,
    val importedAt: Long,
    val updatedAt: Long,
)

@Dao
interface TerminalDao {
    @Query("SELECT * FROM channels WHERE channelId = :channelId") suspend fun channel(channelId: String): ChannelEntity?
    @Query("SELECT * FROM channels ORDER BY installedAt DESC") suspend fun channels(): List<ChannelEntity>
    @Insert(onConflict = OnConflictStrategy.IGNORE) suspend fun insertChannel(channel: ChannelEntity): Long
    @Query("UPDATE channels SET nextSequence=:nextSequence, spentUnits=:spentUnits, lastVoucherDigest=:digest, updatedAt=:now WHERE channelId=:channelId AND nextSequence=:expectedSequence")
    suspend fun advanceChannel(channelId: String, expectedSequence: Long, nextSequence: Long, spentUnits: String, digest: String, now: Long): Int
    @Insert(onConflict = OnConflictStrategy.ABORT) suspend fun insertSale(sale: SaleEntity)
    @Query("SELECT * FROM sales WHERE requestId = :requestId") suspend fun sale(requestId: String): SaleEntity?
    @Query("SELECT * FROM sales ORDER BY createdAt DESC LIMIT :limit") suspend fun sales(limit: Int = 100): List<SaleEntity>
    @Query("UPDATE sales SET state=:state, payloadNonce=:nonce, payloadCiphertext=:ciphertext, updatedAt=:now WHERE requestId=:requestId AND state=:expectedState")
    suspend fun transition(requestId: String, expectedState: String, state: String, nonce: ByteArray, ciphertext: ByteArray, now: Long): Int
    @Query("SELECT * FROM orders WHERE orderId = :orderId") suspend fun order(orderId: String): OrderEntity?
    @Query("SELECT * FROM orders ORDER BY importedAt,orderId LIMIT :limit") suspend fun orders(limit: Int = 100): List<OrderEntity>
    @Insert(onConflict = OnConflictStrategy.IGNORE) suspend fun insertOrder(order: OrderEntity): Long
    @Query("UPDATE orders SET state='REQUESTED',requestId=:requestId,updatedAt=:now WHERE orderId=:orderId AND state='IMPORTED' AND expiresAt>:nowSeconds")
    suspend fun markOrderRequested(orderId: String, requestId: String, nowSeconds: Long, now: Long): Int
}

@Database(entities = [ChannelEntity::class, SaleEntity::class, OrderEntity::class], version = 2, exportSchema = true)
abstract class TerminalDatabase : RoomDatabase() {
    abstract fun terminalDao(): TerminalDao

    companion object {
        private val migration1To2 = object : Migration(1, 2) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    """CREATE TABLE IF NOT EXISTS orders (
                      orderId TEXT NOT NULL PRIMARY KEY,
                      orderRefHash TEXT NOT NULL,
                      orderVersion TEXT NOT NULL,
                      grossUnits TEXT NOT NULL,
                      receiptCommitment TEXT NOT NULL,
                      expiresAt INTEGER NOT NULL,
                      state TEXT NOT NULL,
                      payloadNonce BLOB NOT NULL,
                      payloadCiphertext BLOB NOT NULL,
                      requestId TEXT,
                      importedAt INTEGER NOT NULL,
                      updatedAt INTEGER NOT NULL
                    )""".trimIndent(),
                )
                db.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS index_orders_orderRefHash_orderVersion ON orders(orderRefHash,orderVersion)")
                db.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS index_orders_requestId ON orders(requestId)")
            }
        }

        fun open(context: Context): TerminalDatabase = Room.databaseBuilder(
            context.applicationContext,
            TerminalDatabase::class.java,
            "openbalance-terminal.db",
        ).setJournalMode(JournalMode.WRITE_AHEAD_LOGGING)
            .addMigrations(migration1To2)
            .addCallback(object : Callback() {
                override fun onOpen(db: SupportSQLiteDatabase) {
                    db.execSQL("PRAGMA synchronous=FULL")
                }
            }).build()
    }
}
