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
}

@Database(entities = [ChannelEntity::class, SaleEntity::class], version = 1, exportSchema = true)
abstract class TerminalDatabase : RoomDatabase() {
    abstract fun terminalDao(): TerminalDao

    companion object {
        fun open(context: Context): TerminalDatabase = Room.databaseBuilder(
            context.applicationContext,
            TerminalDatabase::class.java,
            "openbalance-terminal.db",
        ).setJournalMode(JournalMode.WRITE_AHEAD_LOGGING)
            .addCallback(object : Callback() {
                override fun onOpen(db: SupportSQLiteDatabase) {
                    db.execSQL("PRAGMA synchronous=FULL")
                }
            }).build()
    }
}
