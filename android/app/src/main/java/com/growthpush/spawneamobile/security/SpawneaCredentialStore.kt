package com.growthpush.spawneamobile.security

import android.system.Os
import android.system.OsConstants
import java.io.Closeable
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.nio.charset.StandardCharsets
import java.util.Properties

internal data class CredentialRecord(
    val serverUrl: String,
    val activeAlias: String,
    val ivB64: String,
    val ciphertextB64: String,
)

internal data class CredentialState(
    val serverUrl: String?,
    val hasKey: Boolean,
    val incomplete: Boolean,
)

internal sealed class MetadataReadResult {
  object Empty : MetadataReadResult()
  object Corrupted : MetadataReadResult()
  data class Valid(val record: CredentialRecord) : MetadataReadResult()
}

internal interface MetadataPersistence {
  fun read(): MetadataReadResult
  fun write(record: CredentialRecord): Boolean
  fun clear(): Boolean
  fun hasPersistedData(): Boolean
}

internal interface KeystoreSlotBackend {
  fun containsAlias(alias: String): Boolean
  fun deleteAliasStrict(alias: String)
}

internal data class SaveOperationStart(
    val opGen: Long,
    val pendingAlias: String,
)

internal sealed class CommitOutcome {
  object Succeeded : CommitOutcome()
  object StaleOperation : CommitOutcome()
  object Failed : CommitOutcome()
  object Uncertain : CommitOutcome()
  object NotConfigured : CommitOutcome()
}

/**
 * Abstraction for durable atomic file operations so JVM unit tests can observe
 * write/fsync/rename/dir-sync ordering and inject directory-sync failures
 * without invoking Android's `android.system.Os` stubs.
 */
internal interface SyncableTempFile : Closeable {
  fun write(bytes: ByteArray)

  fun fsync()
}

internal interface AtomicFileBackend {
  fun openTempFile(tempFile: File): SyncableTempFile

  fun renameTempFile(tempFile: File, targetFile: File): Boolean

  fun syncDirectory(directory: File)
}

internal object AndroidAtomicFileBackend : AtomicFileBackend {
  override fun openTempFile(tempFile: File): SyncableTempFile {
    val fos = FileOutputStream(tempFile, false)
    return object : SyncableTempFile {
      override fun write(bytes: ByteArray) {
        fos.write(bytes)
        fos.flush()
      }

      override fun fsync() {
        fos.fd.sync()
      }

      override fun close() {
        fos.close()
      }
    }
  }

  override fun renameTempFile(tempFile: File, targetFile: File): Boolean =
      tempFile.renameTo(targetFile)

  override fun syncDirectory(directory: File) {
    val fd = Os.open(directory.absolutePath, OsConstants.O_RDONLY, 0)
    var primaryFailure: Throwable? = null
    try {
      Os.fsync(fd)
    } catch (t: Throwable) {
      primaryFailure = t
      throw t
    } finally {
      try {
        Os.close(fd)
      } catch (closeErr: Throwable) {
        if (primaryFailure == null) {
          throw closeErr
        }
      }
    }
  }
}

/**
 * Atomic property-file persistence for the single durable credential metadata
 * record (serverUrl + active Keystore alias + IV + ciphertext).
 */
internal class AtomicRecordFilePersistence(
    private val targetFile: File,
    private val fileBackend: AtomicFileBackend = AndroidAtomicFileBackend,
) : MetadataPersistence {
  private val parentDir: File = targetFile.absoluteFile.parentFile ?: File(".")
  private val tempFile = File(parentDir, "${targetFile.name}.tmp")

  init {
    if (tempFile.exists()) {
      tempFile.delete()
    }
  }

  override fun hasPersistedData(): Boolean = targetFile.exists()

  override fun read(): MetadataReadResult {
    if (tempFile.exists()) {
      tempFile.delete()
    }
    if (!targetFile.exists()) {
      return MetadataReadResult.Empty
    }
    return try {
      val props = Properties()
      FileInputStream(targetFile).use { fis ->
        InputStreamReader(fis, StandardCharsets.UTF_8).use { reader ->
          props.load(reader)
        }
      }
      val version = props.getProperty(KEY_VERSION)
      val serverUrl = props.getProperty(KEY_SERVER_URL)?.trim().orEmpty()
      val activeAlias = props.getProperty(KEY_ACTIVE_ALIAS)?.trim().orEmpty()
      val ivB64 = props.getProperty(KEY_IV)?.trim().orEmpty()
      val ciphertextB64 = props.getProperty(KEY_CIPHERTEXT)?.trim().orEmpty()
      if (
          version != RECORD_VERSION ||
              serverUrl.isEmpty() ||
              activeAlias.isEmpty() ||
              ivB64.isEmpty() ||
              ciphertextB64.isEmpty()
      ) {
        MetadataReadResult.Corrupted
      } else {
        MetadataReadResult.Valid(
            CredentialRecord(
                serverUrl = serverUrl,
                activeAlias = activeAlias,
                ivB64 = ivB64,
                ciphertextB64 = ciphertextB64,
            ),
        )
      }
    } catch (_: Exception) {
      MetadataReadResult.Corrupted
    }
  }

  override fun write(record: CredentialRecord): Boolean {
    return try {
      parentDir.mkdirs()
      val props =
          Properties().apply {
            setProperty(KEY_VERSION, RECORD_VERSION)
            setProperty(KEY_SERVER_URL, record.serverUrl)
            setProperty(KEY_ACTIVE_ALIAS, record.activeAlias)
            setProperty(KEY_IV, record.ivB64)
            setProperty(KEY_CIPHERTEXT, record.ciphertextB64)
          }
      val buffer = java.io.ByteArrayOutputStream()
      OutputStreamWriter(buffer, StandardCharsets.UTF_8).use { writer ->
        props.store(writer, null)
        writer.flush()
      }
      fileBackend.openTempFile(tempFile).use { handle ->
        handle.write(buffer.toByteArray())
        handle.fsync()
      }
      if (!fileBackend.renameTempFile(tempFile, targetFile)) {
        tempFile.delete()
        return false
      }
      fileBackend.syncDirectory(parentDir)
      true
    } catch (_: Exception) {
      tempFile.delete()
      false
    }
  }

  override fun clear(): Boolean {
    return try {
      if (tempFile.exists()) {
        tempFile.delete()
      }
      var deletedTarget = false
      if (targetFile.exists()) {
        if (!targetFile.delete()) {
          return false
        }
        deletedTarget = true
      }
      if (deletedTarget) {
        fileBackend.syncDirectory(parentDir)
      }
      !targetFile.exists()
    } catch (_: Exception) {
      false
    }
  }

  companion object {
    private const val RECORD_VERSION = "1"
    private const val KEY_VERSION = "version"
    private const val KEY_SERVER_URL = "serverUrl"
    private const val KEY_ACTIVE_ALIAS = "activeAlias"
    private const val KEY_IV = "iv"
    private const val KEY_CIPHERTEXT = "ciphertext"
  }
}

/**
 * Coordinates atomic replacement, rollback on commit failure, startup crash
 * reconciliation, strict deletion, and operation-generation serialization.
 */
internal class SpawneaCredentialStore(
    private val persistence: MetadataPersistence,
    private val keystore: KeystoreSlotBackend,
    private val aliasSlotA: String,
    private val aliasSlotB: String,
) {
  private val lock = Any()

  private var operationGeneration: Long = 0L
  private var authInProgress: Boolean = false
  private var deleteInProgress: Boolean = false
  private var reservedSlotAlias: String? = null
  private var cachedRecord: CredentialRecord? = null

  fun beginSaveOperation(): SaveOperationStart? {
    synchronized(lock) {
      if (authInProgress || deleteInProgress) {
        return null
      }
      val current = readValidatedRecordLocked()?.activeAlias
      val pendingAlias = if (current == aliasSlotA) aliasSlotB else aliasSlotA
      operationGeneration += 1L
      authInProgress = true
      reservedSlotAlias = pendingAlias
      return SaveOperationStart(opGen = operationGeneration, pendingAlias = pendingAlias)
    }
  }

  fun beginReadOperation(): Long? {
    synchronized(lock) {
      if (authInProgress || deleteInProgress) {
        return null
      }
      operationGeneration += 1L
      authInProgress = true
      reservedSlotAlias = null
      return operationGeneration
    }
  }

  fun isOperationCurrent(opGen: Long): Boolean {
    synchronized(lock) {
      return authInProgress && operationGeneration == opGen
    }
  }

  fun completeOperation(opGen: Long): Boolean {
    synchronized(lock) {
      if (!authInProgress || operationGeneration != opGen) {
        return false
      }
      authInProgress = false
      reservedSlotAlias = null
      return true
    }
  }

  /**
   * Releases an in-flight save operation if [opGen] still owns [pendingAlias].
   * Never deletes any Keystore alias; inactive slots are overwritten only on
   * the next save or removed by explicit user deletion.
   */
  fun cancelOrFailSaveOperation(opGen: Long, pendingAlias: String): Boolean {
    synchronized(lock) {
      if (!authInProgress || operationGeneration != opGen || reservedSlotAlias != pendingAlias) {
        return false
      }
      readValidatedRecordLocked()
      authInProgress = false
      reservedSlotAlias = null
      return true
    }
  }

  fun cancelOrFailReadOperation(opGen: Long): Boolean = completeOperation(opGen)

  fun invalidateOperations(): Long {
    synchronized(lock) {
      operationGeneration += 1L
      authInProgress = false
      reservedSlotAlias = null
      return operationGeneration
    }
  }

  fun getCredentialState(): CredentialState {
    synchronized(lock) {
      return when (val result = persistence.read()) {
        is MetadataReadResult.Empty -> {
          cachedRecord = null
          CredentialState(serverUrl = null, hasKey = false, incomplete = false)
        }
        is MetadataReadResult.Corrupted -> {
          cachedRecord = null
          CredentialState(serverUrl = null, hasKey = false, incomplete = true)
        }
        is MetadataReadResult.Valid -> {
          val record = result.record
          if (
              (record.activeAlias != aliasSlotA && record.activeAlias != aliasSlotB) ||
                  !keystore.containsAlias(record.activeAlias)
          ) {
            cachedRecord = null
            CredentialState(serverUrl = null, hasKey = false, incomplete = true)
          } else {
            cachedRecord = record
            CredentialState(serverUrl = record.serverUrl, hasKey = true, incomplete = false)
          }
        }
      }
    }
  }

  fun getActiveRecordForRead(): CredentialRecord? {
    synchronized(lock) {
      val state = getCredentialState()
      if (!state.hasKey) {
        return null
      }
      return cachedRecord
    }
  }

  fun commitNewCredentials(
      opGen: Long,
      serverUrl: String,
      pendingAlias: String,
      ivB64: String,
      ciphertextB64: String,
  ): CommitOutcome {
    val trimmedUrl = serverUrl.trim()
    if (trimmedUrl.isEmpty() || ivB64.isBlank() || ciphertextB64.isBlank()) {
      return CommitOutcome.Failed
    }

    synchronized(lock) {
      if (!authInProgress || operationGeneration != opGen || reservedSlotAlias != pendingAlias) {
        return CommitOutcome.StaleOperation
      }

      val previousRecord = readValidatedRecordLocked()
      if (
          (pendingAlias != aliasSlotA && pendingAlias != aliasSlotB) ||
              !keystore.containsAlias(pendingAlias)
      ) {
        // Fail closed if the pending Keystore alias vanished before commit.
        return CommitOutcome.Failed
      }

      val newRecord =
          CredentialRecord(
              serverUrl = trimmedUrl,
              activeAlias = pendingAlias,
              ivB64 = ivB64,
              ciphertextB64 = ciphertextB64,
          )

      val written =
          try {
            persistence.write(newRecord)
          } catch (_: Exception) {
            false
          }

      if (!written) {
        val rollbackVerified = rollbackMetadataLocked(previousRecord)
        return if (rollbackVerified) CommitOutcome.Failed else CommitOutcome.Uncertain
      }

      cachedRecord = newRecord
      return CommitOutcome.Succeeded
    }
  }

  fun updateServerUrl(serverUrl: String): CommitOutcome {
    val trimmedUrl = serverUrl.trim()
    if (trimmedUrl.isEmpty()) {
      return CommitOutcome.Failed
    }
    synchronized(lock) {
      val previousRecord = readValidatedRecordLocked() ?: return CommitOutcome.NotConfigured
      if (!keystore.containsAlias(previousRecord.activeAlias)) {
        cachedRecord = null
        return CommitOutcome.NotConfigured
      }

      val updated = previousRecord.copy(serverUrl = trimmedUrl)
      val written =
          try {
            persistence.write(updated)
          } catch (_: Exception) {
            false
          }

      if (!written) {
        val rollbackVerified = rollbackMetadataLocked(previousRecord)
        return if (rollbackVerified) CommitOutcome.Failed else CommitOutcome.Uncertain
      }

      cachedRecord = updated
      return CommitOutcome.Succeeded
    }
  }

  /**
   * Explicit user deletion: invalidates pending biometric operations and uses
   * strict deletion to verify both Keystore aliases and persisted metadata are removed.
   */
  fun deleteAllStrict(onInvalidatePending: () -> Unit = {}): Boolean {
    synchronized(lock) {
      deleteInProgress = true
      operationGeneration += 1L
      authInProgress = false
      reservedSlotAlias = null
    }

    try {
      onInvalidatePending()
      synchronized(lock) {
        keystore.deleteAliasStrict(aliasSlotA)
        keystore.deleteAliasStrict(aliasSlotB)
        val cleared = persistence.clear()
        cachedRecord = null
        if (!cleared || persistence.hasPersistedData()) {
          return false
        }
        if (keystore.containsAlias(aliasSlotA) || keystore.containsAlias(aliasSlotB)) {
          return false
        }
        return true
      }
    } finally {
      synchronized(lock) {
        deleteInProgress = false
      }
    }
  }

  private fun readValidatedRecordLocked(): CredentialRecord? {
    val result = persistence.read()
    if (result !is MetadataReadResult.Valid) {
      cachedRecord = null
      return null
    }
    val record = result.record
    if (!keystore.containsAlias(record.activeAlias)) {
      cachedRecord = null
      return null
    }
    cachedRecord = record
    return record
  }

  private fun rollbackMetadataLocked(previousRecord: CredentialRecord?): Boolean {
    return try {
      if (previousRecord != null) {
        val rolledBack = persistence.write(previousRecord)
        val onDisk = persistence.read()
        if (rolledBack && onDisk is MetadataReadResult.Valid && onDisk.record == previousRecord) {
          cachedRecord = previousRecord
          true
        } else {
          readValidatedRecordLocked()
          false
        }
      } else {
        val cleared = persistence.clear()
        val emptyOnDisk =
            !persistence.hasPersistedData() && persistence.read() is MetadataReadResult.Empty
        if (cleared && emptyOnDisk) {
          cachedRecord = null
          true
        } else {
          readValidatedRecordLocked()
          false
        }
      }
    } catch (_: Exception) {
      try {
        readValidatedRecordLocked()
      } catch (_: Exception) {
        cachedRecord = null
      }
      false
    }
  }
}
