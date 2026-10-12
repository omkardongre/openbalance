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

@Entity(
    tableName = "sales",
    indices = [
        Index(value = ["channelId", "sequence"], unique = true),
        Index(value = ["paymentId"], unique = true),
        Index(value = ["relayState", "nextUploadAt", "uploadLeaseUntil", "createdAt"], name = "index_sales_relay_ready"),
    ],
)
data class SaleEntity(
    @PrimaryKey val requestId: String,
    val channelId: String,
    val sequence: Long,
    val paymentId: String,
    val state: String,
    val payloadNonce: ByteArray,
    val payloadCiphertext: ByteArray,
    val relayState: String,
    val uploadAttempts: Int,
    val nextUploadAt: Long,
    val uploadLeaseOwner: String?,
    val uploadLeaseUntil: Long?,
    val transactionHash: String?,
    val lastUploadError: String?,
    val relayAcknowledgedAt: Long?,
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

/**
 * A sale taken online: the customer scanned the stall's code and paid from their own balance. It
 * holds no money and no secrets (the order link is kept in memory only), just what the Sales list
 * and the payment screen need.
 */
@Entity(tableName = "online_sales", indices = [Index(value = ["createdAt"], name = "index_online_sales_created")])
data class OnlineSaleEntity(
    @PrimaryKey val orderId: String,
    val reference: String,
    val description: String,
    val grossUnits: String,
    val assetSymbol: String,
    val assetDecimals: Int,
    /** WAITING, CUSTOMER_PAYING, SIGNED, PAID, CANCELLED, EXPIRED or DECLINED. */
    val state: String,
    val paymentId: String?,
    val transactionHash: String?,
    /** Epoch seconds. While WAITING it is when the code stops being offered; once SIGNED, when the payment lapses. */
    val expiresAt: Long,
    val createdAt: Long,
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
    @Query("SELECT * FROM sales WHERE channelId = :channelId AND sequence = :sequence")
    suspend fun saleAt(channelId: String, sequence: Long): SaleEntity?
    /** Version 2 requests the customer has not answered yet: no reserve is chosen, so none is held. */
    @Query("SELECT * FROM sales WHERE state = 'PREPARED' AND channelId LIKE 'unbound:%'")
    suspend fun preparedUnbound(): List<SaleEntity>
    /**
     * Ties an answered version 2 request to the reserve the customer chose. The unique
     * (channelId, sequence) index makes this the claim on that reserve position.
     */
    @Query("UPDATE sales SET channelId=:channelId, sequence=:sequence, state='ATTENDEE_SIGNED', payloadNonce=:nonce, payloadCiphertext=:ciphertext, updatedAt=:now WHERE requestId=:requestId AND state='PREPARED' AND channelId=:unbound")
    suspend fun bindSale(requestId: String, unbound: String, channelId: String, sequence: Long, nonce: ByteArray, ciphertext: ByteArray, now: Long): Int
    @Query("DELETE FROM sales WHERE requestId = :requestId AND state = 'PREPARED' AND relayState = 'NOT_READY'")
    suspend fun deleteUnansweredSale(requestId: String): Int
    @Query("UPDATE orders SET state='EXPIRED',updatedAt=:now WHERE requestId=:requestId AND state='REQUESTED'")
    suspend fun expireRequestedOrder(requestId: String, now: Long): Int
    @Query("UPDATE sales SET state=:state, payloadNonce=:nonce, payloadCiphertext=:ciphertext, updatedAt=:now WHERE requestId=:requestId AND state=:expectedState")
    suspend fun transition(requestId: String, expectedState: String, state: String, nonce: ByteArray, ciphertext: ByteArray, now: Long): Int
    @Query("UPDATE sales SET relayState='PENDING',nextUploadAt=:now,updatedAt=:now WHERE requestId=:requestId AND state='ACCEPTED' AND relayState='NOT_READY'")
    suspend fun markRelayPending(requestId: String, now: Long): Int
    @Query("""SELECT * FROM sales s WHERE s.state='ACCEPTED' AND s.relayState IN ('PENDING','RETRY','UPLOADING','RELAYED') AND s.nextUploadAt<=:now AND (s.uploadLeaseUntil IS NULL OR s.uploadLeaseUntil<=:now) AND NOT EXISTS (SELECT 1 FROM sales p WHERE p.channelId=s.channelId AND p.sequence<s.sequence AND p.relayAcknowledgedAt IS NULL AND p.relayState!='SETTLED') ORDER BY s.createdAt,s.requestId LIMIT :limit""")
    suspend fun uploadCandidates(now: Long, limit: Int): List<SaleEntity>
    @Query("""UPDATE sales SET relayState='UPLOADING',uploadAttempts=uploadAttempts+1,uploadLeaseOwner=:owner,uploadLeaseUntil=:leaseUntil,updatedAt=:now WHERE requestId=:requestId AND state='ACCEPTED' AND relayState IN ('PENDING','RETRY','UPLOADING','RELAYED') AND (uploadLeaseUntil IS NULL OR uploadLeaseUntil<=:now)""")
    suspend fun leaseUpload(requestId: String, owner: String, now: Long, leaseUntil: Long): Int
    @Query("""UPDATE sales SET payloadNonce=:nonce,payloadCiphertext=:ciphertext,updatedAt=:now WHERE requestId=:requestId AND relayState='UPLOADING' AND uploadLeaseOwner=:owner AND uploadLeaseUntil>:now""")
    suspend fun saveUploadPayload(requestId: String, owner: String, nonce: ByteArray, ciphertext: ByteArray, now: Long): Int
    @Query("""UPDATE sales SET relayState=:relayState,nextUploadAt=:nextUploadAt,transactionHash=COALESCE(:transactionHash,transactionHash),lastUploadError=:lastError,relayAcknowledgedAt=COALESCE(:acknowledgedAt,relayAcknowledgedAt),uploadLeaseOwner=NULL,uploadLeaseUntil=NULL,updatedAt=:now WHERE requestId=:requestId AND relayState='UPLOADING' AND uploadLeaseOwner=:owner AND uploadLeaseUntil>:now""")
    suspend fun completeUploadLease(requestId: String, owner: String, relayState: String, nextUploadAt: Long, transactionHash: String?, lastError: String?, acknowledgedAt: Long?, now: Long): Int
    @Query("SELECT COUNT(*) FROM sales WHERE state='ACCEPTED' AND relayState IN ('PENDING','RETRY','UPLOADING','RELAYED')")
    suspend fun pendingRelayCount(): Int
    @Query("SELECT * FROM sales WHERE state='ACCEPTED' AND relayState IN ('PENDING','RETRY','UPLOADING','RELAYED','QUARANTINED') ORDER BY createdAt")
    suspend fun unsettledSales(): List<SaleEntity>
    @Query("SELECT * FROM orders WHERE orderId = :orderId") suspend fun order(orderId: String): OrderEntity?
    @Query("SELECT * FROM orders ORDER BY importedAt DESC,orderId LIMIT :limit") suspend fun orders(limit: Int = 100): List<OrderEntity>
    @Insert(onConflict = OnConflictStrategy.IGNORE) suspend fun insertOrder(order: OrderEntity): Long
    @Insert(onConflict = OnConflictStrategy.ABORT) suspend fun insertOnlineSale(sale: OnlineSaleEntity)
    @Query("SELECT * FROM online_sales ORDER BY createdAt DESC LIMIT :limit") suspend fun onlineSales(limit: Int): List<OnlineSaleEntity>
    @Query("SELECT * FROM online_sales WHERE orderId=:orderId") suspend fun onlineSale(orderId: String): OnlineSaleEntity?
    /** Sales still moving, plus recently lapsed ones that a late-finalizing payment could still settle. */
    @Query("SELECT * FROM online_sales WHERE state IN ('WAITING','CUSTOMER_PAYING','SIGNED') OR (state='EXPIRED' AND paymentId IS NOT NULL AND updatedAt>:since) ORDER BY createdAt")
    suspend fun pollableOnlineSales(since: Long): List<OnlineSaleEntity>
    @Query("UPDATE online_sales SET state=:state,paymentId=COALESCE(:paymentId,paymentId),transactionHash=COALESCE(:transactionHash,transactionHash),expiresAt=COALESCE(:expiresAt,expiresAt),updatedAt=:now WHERE orderId=:orderId AND state IN (:from)")
    suspend fun transitionOnlineSale(orderId: String, from: List<String>, state: String, paymentId: String?, transactionHash: String?, expiresAt: Long?, now: Long): Int
    @Query("UPDATE orders SET state='REQUESTED',requestId=:requestId,updatedAt=:now WHERE orderId=:orderId AND state='IMPORTED' AND expiresAt>:nowSeconds")
    suspend fun markOrderRequested(orderId: String, requestId: String, nowSeconds: Long, now: Long): Int
}

@Database(entities = [ChannelEntity::class, SaleEntity::class, OrderEntity::class, OnlineSaleEntity::class], version = 4, exportSchema = true)
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
        private val migration2To3 = object : Migration(2, 3) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE sales ADD COLUMN relayState TEXT NOT NULL DEFAULT 'NOT_READY'")
                db.execSQL("ALTER TABLE sales ADD COLUMN uploadAttempts INTEGER NOT NULL DEFAULT 0")
                db.execSQL("ALTER TABLE sales ADD COLUMN nextUploadAt INTEGER NOT NULL DEFAULT 0")
                db.execSQL("ALTER TABLE sales ADD COLUMN uploadLeaseOwner TEXT")
                db.execSQL("ALTER TABLE sales ADD COLUMN uploadLeaseUntil INTEGER")
                db.execSQL("ALTER TABLE sales ADD COLUMN transactionHash TEXT")
                db.execSQL("ALTER TABLE sales ADD COLUMN lastUploadError TEXT")
                db.execSQL("ALTER TABLE sales ADD COLUMN relayAcknowledgedAt INTEGER")
                db.execSQL("CREATE INDEX IF NOT EXISTS index_sales_relay_ready ON sales(relayState,nextUploadAt,uploadLeaseUntil,createdAt)")
            }
        }

        private val migration3To4 = object : Migration(3, 4) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    """CREATE TABLE IF NOT EXISTS online_sales (
                      orderId TEXT NOT NULL PRIMARY KEY,
                      reference TEXT NOT NULL,
                      description TEXT NOT NULL,
                      grossUnits TEXT NOT NULL,
                      assetSymbol TEXT NOT NULL,
                      assetDecimals INTEGER NOT NULL,
                      state TEXT NOT NULL,
                      paymentId TEXT,
                      transactionHash TEXT,
                      expiresAt INTEGER NOT NULL,
                      createdAt INTEGER NOT NULL,
                      updatedAt INTEGER NOT NULL
                    )""".trimIndent(),
                )
                db.execSQL("CREATE INDEX IF NOT EXISTS index_online_sales_created ON online_sales(createdAt)")
            }
        }

        fun open(context: Context): TerminalDatabase = Room.databaseBuilder(
            context.applicationContext,
            TerminalDatabase::class.java,
            "openbalance-terminal.db",
        ).setJournalMode(JournalMode.WRITE_AHEAD_LOGGING)
            .addMigrations(migration1To2, migration2To3, migration3To4)
            .addCallback(object : Callback() {
                override fun onOpen(db: SupportSQLiteDatabase) {
                    db.execSQL("PRAGMA synchronous=FULL")
                }
            }).build()
    }
}
