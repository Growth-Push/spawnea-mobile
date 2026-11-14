package com.growthpush.spawneamobile.security

import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class SpawneaCredentialStoreTest {
  @get:Rule val tempFolder = TemporaryFolder()

  private class InMemoryFaultyPersistence(
      var failNextWrite: Boolean = false,
      var failClear: Boolean = false,
  ) : MetadataPersistence {
    // Simulates a dirty in-memory map (like SharedPreferencesImpl.mMap) mutated before disk failure.
    var inMemoryMap: CredentialRecord? = null
    var persisted: CredentialRecord? = null
    var forceCorrupted: Boolean = false

    override fun hasPersistedData(): Boolean = persisted != null || forceCorrupted

    override fun read(): MetadataReadResult {
      if (forceCorrupted) return MetadataReadResult.Corrupted
      val rec = persisted ?: return MetadataReadResult.Empty
      return MetadataReadResult.Valid(rec)
    }

    override fun write(record: CredentialRecord): Boolean {
      inMemoryMap = record
      if (failNextWrite) {
        failNextWrite = false
        return false
      }
      persisted = record
      return true
    }

    override fun clear(): Boolean {
      inMemoryMap = null
      if (failClear) {
        failClear = false
        return false
      }
      persisted = null
      forceCorrupted = false
      return true
    }
  }

  private class RecordingAtomicFileBackend(
      private val events: MutableList<String> = mutableListOf(),
      var failNextDirSync: Boolean = false,
      var alwaysFailDirSync: Boolean = false,
      var failNextTempOpenAfterDirSyncFailure: Boolean = false,
  ) : AtomicFileBackend {
    private var failNextTempOpen: Boolean = false

    override fun openTempFile(tempFile: File): SyncableTempFile {
      if (failNextTempOpen) {
        failNextTempOpen = false
        events.add("open_temp_failed")
        throw IOException("Injected temp-file creation failure for $tempFile")
      }
      val fos = FileOutputStream(tempFile, false)
      return object : SyncableTempFile {
        override fun write(bytes: ByteArray) {
          events.add("write_temp")
          fos.write(bytes)
          fos.flush()
        }

        override fun fsync() {
          events.add("fsync_file")
          fos.fd.sync()
        }

        override fun close() {
          fos.close()
        }
      }
    }

    override fun renameTempFile(tempFile: File, targetFile: File): Boolean {
      events.add("rename")
      return tempFile.renameTo(targetFile)
    }

    override fun syncDirectory(directory: File) {
      events.add("fsync_dir")
      if (alwaysFailDirSync) {
        throw IOException("Injected persistent directory sync failure for $directory")
      }
      if (failNextDirSync) {
        failNextDirSync = false
        if (failNextTempOpenAfterDirSyncFailure) {
          failNextTempOpenAfterDirSyncFailure = false
          failNextTempOpen = true
        }
        throw IOException("Injected directory sync failure for $directory")
      }
    }
  }

  private class FakeKeystoreBackend(
      private val events: MutableList<String>? = null,
  ) : KeystoreSlotBackend {
    val aliases = linkedSetOf<String>()
    var failStrictDeleteForAlias: String? = null
    var leaveAliasBehindOnStrictDelete: String? = null
    var throwOnContainsAlias: Boolean = false
    val strictDeletes = mutableListOf<String>()

    fun regenerateSlot(alias: String) {
      events?.add("regenerate_slot:$alias")
      aliases.remove(alias)
      aliases.add(alias)
    }

    override fun containsAlias(alias: String): Boolean {
      if (throwOnContainsAlias) {
        throw IllegalStateException("Injected Keystore containsAlias failure")
      }
      return aliases.contains(alias)
    }

    override fun deleteAliasStrict(alias: String) {
      events?.add("delete_strict:$alias")
      strictDeletes.add(alias)
      if (failStrictDeleteForAlias == alias) {
        throw IllegalStateException("Injected strict delete failure for $alias")
      }
      if (leaveAliasBehindOnStrictDelete != alias) {
        aliases.remove(alias)
      }
    }
  }

  @Test
  fun commitFailureRollsBackInMemoryAndPersistedMetadataAndKeepsPreviousPair() {
    val persistence = InMemoryFaultyPersistence()
    val keystore = FakeKeystoreBackend()
    val store = SpawneaCredentialStore(persistence, keystore, SLOT_A, SLOT_B)

    // Seed initial valid pair in SLOT_A
    val op1 = store.beginSaveOperation()!!
    assertEquals(SLOT_A, op1.pendingAlias)
    keystore.aliases.add(op1.pendingAlias)
    assertEquals(
        CommitOutcome.Succeeded,
        store.commitNewCredentials(op1.opGen, "https://old.tailnet.ts.net", op1.pendingAlias, "iv1", "ct1"),
    )
    assertTrue(store.completeOperation(op1.opGen))

    // Attempt replacement in SLOT_B with a failing native commit
    val op2 = store.beginSaveOperation()!!
    val pending = op2.pendingAlias
    assertEquals(SLOT_B, pending)
    keystore.aliases.add(pending)
    persistence.failNextWrite = true

    val outcome =
        store.commitNewCredentials(op2.opGen, "https://new.tailnet.ts.net", pending, "iv2", "ct2")
    assertEquals(CommitOutcome.Failed, outcome)
    store.completeOperation(op2.opGen)

    // Both in-memory map and persisted metadata must be rolled back to SLOT_A + old URL
    assertEquals("https://old.tailnet.ts.net", persistence.inMemoryMap?.serverUrl)
    assertEquals(SLOT_A, persistence.inMemoryMap?.activeAlias)
    assertEquals("https://old.tailnet.ts.net", persistence.persisted?.serverUrl)
    assertEquals(SLOT_A, persistence.persisted?.activeAlias)
    assertTrue(keystore.containsAlias(SLOT_A))
    assertTrue(keystore.containsAlias(SLOT_B))
    assertTrue(keystore.strictDeletes.isEmpty())

    val recovered = store.getCredentialState()
    assertEquals(CredentialState("https://old.tailnet.ts.net", hasKey = true, incomplete = false), recovered)
  }

  @Test
  fun urlWriteFailureRollsBackToPreviousValidPair() {
    val persistence = InMemoryFaultyPersistence()
    val keystore = FakeKeystoreBackend()
    val store = SpawneaCredentialStore(persistence, keystore, SLOT_A, SLOT_B)

    val op1 = store.beginSaveOperation()!!
    keystore.aliases.add(op1.pendingAlias)
    assertEquals(
        CommitOutcome.Succeeded,
        store.commitNewCredentials(op1.opGen, "https://old.tailnet.ts.net", op1.pendingAlias, "iv1", "ct1"),
    )
    assertTrue(store.completeOperation(op1.opGen))

    persistence.failNextWrite = true
    assertEquals(CommitOutcome.Failed, store.updateServerUrl("https://broken.tailnet.ts.net"))
    assertEquals("https://old.tailnet.ts.net", persistence.inMemoryMap?.serverUrl)
    assertEquals(
        CredentialState("https://old.tailnet.ts.net", hasKey = true, incomplete = false),
        store.getCredentialState(),
    )
  }

  @Test
  fun startupReconcilesCrashBetweenStepsAndMissingKeyReturnsExplicitIncomplete() {
    val file = File(tempFolder.root, "spawnea_credentials.props")
    val jvmFileBackend = RecordingAtomicFileBackend()
    val persistence = AtomicRecordFilePersistence(file, jvmFileBackend)
    val keystore = FakeKeystoreBackend()
    val storeBeforeCrash = SpawneaCredentialStore(persistence, keystore, SLOT_A, SLOT_B)

    // Step 1: initial valid pair in SLOT_A
    val op1 = storeBeforeCrash.beginSaveOperation()!!
    keystore.aliases.add(op1.pendingAlias)
    assertEquals(
        CommitOutcome.Succeeded,
        storeBeforeCrash.commitNewCredentials(op1.opGen, "https://old.example.ts.net", op1.pendingAlias, "iv1", "ct1"),
    )
    storeBeforeCrash.completeOperation(op1.opGen)

    // Crash Case A: pending SLOT_B was generated in Keystore, process crashed BEFORE durable commit
    keystore.aliases.add(SLOT_B)
    val restartedA = SpawneaCredentialStore(AtomicRecordFilePersistence(file, jvmFileBackend), keystore, SLOT_A, SLOT_B)
    val stateA = restartedA.getCredentialState()
    assertEquals(CredentialState("https://old.example.ts.net", hasKey = true, incomplete = false), stateA)
    assertTrue(keystore.containsAlias(SLOT_A))
    assertTrue(keystore.containsAlias(SLOT_B))

    // Crash Case B: durable commit of (newUrl, SLOT_B) succeeded, both aliases remain intact
    keystore.aliases.add(SLOT_B)
    assertTrue(
        persistence.write(
            CredentialRecord("https://new.example.ts.net", SLOT_B, "iv2", "ct2"),
        ),
    )
    val restartedB = SpawneaCredentialStore(AtomicRecordFilePersistence(file, jvmFileBackend), keystore, SLOT_A, SLOT_B)
    val stateB = restartedB.getCredentialState()
    assertEquals(CredentialState("https://new.example.ts.net", hasKey = true, incomplete = false), stateB)
    assertTrue(keystore.containsAlias(SLOT_B))
    assertTrue(keystore.containsAlias(SLOT_A))

    // Crash Case C: metadata points to SLOT_B, but SLOT_B is missing from Keystore -> explicit incomplete
    keystore.aliases.remove(SLOT_B)
    val restartedC = SpawneaCredentialStore(AtomicRecordFilePersistence(file, jvmFileBackend), keystore, SLOT_A, SLOT_B)
    val stateC = restartedC.getCredentialState()
    assertEquals(CredentialState(serverUrl = null, hasKey = false, incomplete = true), stateC)
    assertNull(restartedC.getActiveRecordForRead())
  }

  @Test
  fun deleteDuringSaveOrUnlockInvalidatesGenerationAndIgnoresStaleCallbacks() {
    val persistence = InMemoryFaultyPersistence()
    val keystore = FakeKeystoreBackend()
    val store = SpawneaCredentialStore(persistence, keystore, SLOT_A, SLOT_B)

    // Active save starts in SLOT_A
    val saveOp = store.beginSaveOperation()!!
    keystore.aliases.add(saveOp.pendingAlias)
    assertTrue(store.isOperationCurrent(saveOp.opGen))

    // User triggers delete while save prompt is in flight
    var invalidatedCalled = false
    assertTrue(store.deleteAllStrict { invalidatedCalled = true })
    assertTrue(invalidatedCalled)
    assertFalse(store.isOperationCurrent(saveOp.opGen))

    // Stale save callback arrives late and must be ignored without persisting anything
    assertEquals(
        CommitOutcome.StaleOperation,
        store.commitNewCredentials(saveOp.opGen, "https://stale.ts.net", saveOp.pendingAlias, "iv", "ct"),
    )
    assertFalse(store.completeOperation(saveOp.opGen))
    assertNull(persistence.persisted)

    // Seed valid pair, start unlock/read, then delete during unlock prompt
    val opValid = store.beginSaveOperation()!!
    keystore.aliases.add(opValid.pendingAlias)
    assertEquals(
        CommitOutcome.Succeeded,
        store.commitNewCredentials(opValid.opGen, "https://valid.ts.net", opValid.pendingAlias, "iv", "ct"),
    )
    store.completeOperation(opValid.opGen)

    val readGen = store.beginReadOperation()!!
    assertNotNull(store.getActiveRecordForRead())
    assertTrue(store.deleteAllStrict())
    assertFalse(store.isOperationCurrent(readGen))
    assertFalse(store.completeOperation(readGen))
    assertEquals(CredentialState(serverUrl = null, hasKey = false, incomplete = false), store.getCredentialState())
  }

  @Test
  fun explicitDeleteUsesStrictAliasDeletionAndFailsIfAliasRemains() {
    val persistence = InMemoryFaultyPersistence()
    val keystore = FakeKeystoreBackend()
    val store = SpawneaCredentialStore(persistence, keystore, SLOT_A, SLOT_B)

    val op = store.beginSaveOperation()!!
    keystore.aliases.add(op.pendingAlias)
    assertEquals(
        CommitOutcome.Succeeded,
        store.commitNewCredentials(op.opGen, "https://valid.ts.net", op.pendingAlias, "iv", "ct"),
    )
    store.completeOperation(op.opGen)

    // Case 1: strict delete leaves alias behind -> returns false instead of claiming deleted
    keystore.leaveAliasBehindOnStrictDelete = SLOT_A
    assertFalse(store.deleteAllStrict())
    assertTrue(keystore.strictDeletes.contains(SLOT_A))
    assertTrue(keystore.containsAlias(SLOT_A))

    // Case 2: strict delete throws -> propagates exception
    keystore.leaveAliasBehindOnStrictDelete = null
    keystore.failStrictDeleteForAlias = SLOT_B
    keystore.aliases.add(SLOT_B)
    var threw = false
    try {
      store.deleteAllStrict()
    } catch (_: IllegalStateException) {
      threw = true
    }
    assertTrue(threw)

    // Case 3: both strict deletes succeed -> resolves true and verifies both absent
    keystore.failStrictDeleteForAlias = null
    assertTrue(store.deleteAllStrict())
    assertFalse(keystore.containsAlias(SLOT_A))
    assertFalse(keystore.containsAlias(SLOT_B))
    assertNull(persistence.persisted)
  }

  @Test
  fun statusQueryDuringPendingInitialSavePreservesPendingAliasForCommit() {
    val persistence = InMemoryFaultyPersistence()
    val keystore = FakeKeystoreBackend()
    val store = SpawneaCredentialStore(persistence, keystore, SLOT_A, SLOT_B)

    val op = store.beginSaveOperation()!!
    assertEquals(SLOT_A, op.pendingAlias)
    keystore.aliases.add(op.pendingAlias)

    // Concurrent status & read queries (e.g., Settings focus or Dashboard read) must not delete pending SLOT_A
    assertEquals(CredentialState(serverUrl = null, hasKey = false, incomplete = false), store.getCredentialState())
    assertNull(store.getActiveRecordForRead())
    assertTrue(keystore.containsAlias(SLOT_A))
    assertTrue(keystore.strictDeletes.isEmpty())

    assertEquals(
        CommitOutcome.Succeeded,
        store.commitNewCredentials(op.opGen, "https://initial.ts.net", op.pendingAlias, "iv1", "ct1"),
    )
    assertTrue(store.completeOperation(op.opGen))
    assertEquals(CredentialState("https://initial.ts.net", hasKey = true, incomplete = false), store.getCredentialState())
  }

  @Test
  fun statusQueryDuringPendingReplacementPreservesPendingAliasAndCommitsSafely() {
    val persistence = InMemoryFaultyPersistence()
    val keystore = FakeKeystoreBackend()
    val store = SpawneaCredentialStore(persistence, keystore, SLOT_A, SLOT_B)

    val op1 = store.beginSaveOperation()!!
    keystore.aliases.add(op1.pendingAlias)
    assertEquals(
        CommitOutcome.Succeeded,
        store.commitNewCredentials(op1.opGen, "https://old.ts.net", op1.pendingAlias, "iv1", "ct1"),
    )
    assertTrue(store.completeOperation(op1.opGen))

    // Start replacement in SLOT_B
    val op2 = store.beginSaveOperation()!!
    assertEquals(SLOT_B, op2.pendingAlias)
    keystore.aliases.add(op2.pendingAlias)

    // Concurrent status/read queries while prompt awaits biometrics keep returning A without deleting B
    assertEquals(CredentialState("https://old.ts.net", hasKey = true, incomplete = false), store.getCredentialState())
    assertEquals(SLOT_A, store.getActiveRecordForRead()?.activeAlias)
    assertTrue(keystore.containsAlias(SLOT_B))
    assertTrue(keystore.strictDeletes.isEmpty())

    assertEquals(
        CommitOutcome.Succeeded,
        store.commitNewCredentials(op2.opGen, "https://new.ts.net", op2.pendingAlias, "iv2", "ct2"),
    )
    assertTrue(store.completeOperation(op2.opGen))
    assertEquals(CredentialState("https://new.ts.net", hasKey = true, incomplete = false), store.getCredentialState())
    assertTrue(keystore.containsAlias(SLOT_B))
    assertTrue(keystore.containsAlias(SLOT_A))
  }

  @Test
  fun commitFailsClosedAndKeepsPreviousPairIfPendingAliasDisappeared() {
    val persistence = InMemoryFaultyPersistence()
    val keystore = FakeKeystoreBackend()
    val store = SpawneaCredentialStore(persistence, keystore, SLOT_A, SLOT_B)

    val op1 = store.beginSaveOperation()!!
    keystore.aliases.add(op1.pendingAlias)
    assertEquals(
        CommitOutcome.Succeeded,
        store.commitNewCredentials(op1.opGen, "https://old.ts.net", op1.pendingAlias, "iv1", "ct1"),
    )
    assertTrue(store.completeOperation(op1.opGen))

    val op2 = store.beginSaveOperation()!!
    assertEquals(SLOT_B, op2.pendingAlias)
    // Simulate pending alias missing before commit (never generated or externally evicted)
    assertEquals(
        CommitOutcome.Failed,
        store.commitNewCredentials(op2.opGen, "https://new.ts.net", op2.pendingAlias, "iv2", "ct2"),
    )
    assertTrue(store.completeOperation(op2.opGen))

    assertEquals("https://old.ts.net", persistence.persisted?.serverUrl)
    assertEquals(SLOT_A, persistence.persisted?.activeAlias)
    assertTrue(keystore.containsAlias(SLOT_A))
  }

  @Test
  fun throwingBackendDuringSaveStartDoesNotLeaveAuthBusy() {
    val persistence = InMemoryFaultyPersistence()
    val keystore = FakeKeystoreBackend()
    val store = SpawneaCredentialStore(persistence, keystore, SLOT_A, SLOT_B)

    // Seed SLOT_A so beginSaveOperation touches keystore.containsAlias during reconciliation
    val op1 = store.beginSaveOperation()!!
    keystore.aliases.add(op1.pendingAlias)
    assertEquals(
        CommitOutcome.Succeeded,
        store.commitNewCredentials(op1.opGen, "https://old.ts.net", op1.pendingAlias, "iv1", "ct1"),
    )
    assertTrue(store.completeOperation(op1.opGen))

    keystore.throwOnContainsAlias = true
    var threw = false
    try {
      store.beginSaveOperation()
    } catch (_: IllegalStateException) {
      threw = true
    }
    assertTrue(threw)

    // Recovery: next beginSaveOperation must not fail with null ("busy")
    keystore.throwOnContainsAlias = false
    val op2 = store.beginSaveOperation()
    assertNotNull(op2)
    assertTrue(store.completeOperation(op2!!.opGen))
  }

  @Test
  fun commitSyncsTempFileRenameAndContainingDirWithoutSideEffectAliasDeletion() {
    val events = mutableListOf<String>()
    val file = File(tempFolder.root, "spawnea_credentials.props")
    val fileBackend = RecordingAtomicFileBackend(events = events)
    val persistence = AtomicRecordFilePersistence(file, fileBackend)
    val keystore = FakeKeystoreBackend(events = events)
    val store = SpawneaCredentialStore(persistence, keystore, SLOT_A, SLOT_B)

    // Seed valid initial pair in SLOT_A
    val op1 = store.beginSaveOperation()!!
    keystore.regenerateSlot(op1.pendingAlias)
    assertEquals(
        CommitOutcome.Succeeded,
        store.commitNewCredentials(op1.opGen, "https://old.tailnet.ts.net", op1.pendingAlias, "iv1", "ct1"),
    )
    assertTrue(store.completeOperation(op1.opGen))
    events.clear()

    // Replace with SLOT_B: durability barrier runs in order and neither slot is deleted as a side effect
    val op2 = store.beginSaveOperation()!!
    assertEquals(SLOT_B, op2.pendingAlias)
    keystore.regenerateSlot(op2.pendingAlias)
    assertEquals(
        CommitOutcome.Succeeded,
        store.commitNewCredentials(op2.opGen, "https://new.tailnet.ts.net", op2.pendingAlias, "iv2", "ct2"),
    )
    assertTrue(store.completeOperation(op2.opGen))

    assertEquals(
        listOf(
            "regenerate_slot:$SLOT_B",
            "write_temp",
            "fsync_file",
            "rename",
            "fsync_dir",
        ),
        events,
    )
    assertTrue(keystore.containsAlias(SLOT_A))
    assertTrue(keystore.containsAlias(SLOT_B))
    assertTrue(keystore.strictDeletes.isEmpty())
  }

  @Test
  fun directorySyncFailureFailsCommitClosedAndPreservesPreviousPair() {
    val events = mutableListOf<String>()
    val file = File(tempFolder.root, "spawnea_credentials.props")
    val fileBackend = RecordingAtomicFileBackend(events = events)
    val persistence = AtomicRecordFilePersistence(file, fileBackend)
    val keystore = FakeKeystoreBackend(events = events)
    val store = SpawneaCredentialStore(persistence, keystore, SLOT_A, SLOT_B)

    // Seed valid initial pair in SLOT_A
    val op1 = store.beginSaveOperation()!!
    keystore.regenerateSlot(op1.pendingAlias)
    assertEquals(
        CommitOutcome.Succeeded,
        store.commitNewCredentials(op1.opGen, "https://old.tailnet.ts.net", op1.pendingAlias, "iv1", "ct1"),
    )
    assertTrue(store.completeOperation(op1.opGen))
    events.clear()

    // Case 1: one-shot directory sync failure where rollback succeeds cleanly -> CommitOutcome.Failed, both slots kept
    fileBackend.failNextDirSync = true
    val op2 = store.beginSaveOperation()!!
    assertEquals(SLOT_B, op2.pendingAlias)
    keystore.regenerateSlot(op2.pendingAlias)
    assertEquals(
        CommitOutcome.Failed,
        store.commitNewCredentials(op2.opGen, "https://new.tailnet.ts.net", op2.pendingAlias, "iv2", "ct2"),
    )
    assertTrue(store.completeOperation(op2.opGen))

    assertTrue(keystore.strictDeletes.isEmpty())
    assertTrue(keystore.containsAlias(SLOT_A))
    assertTrue(keystore.containsAlias(SLOT_B))
    assertEquals(
        CredentialState("https://old.tailnet.ts.net", hasKey = true, incomplete = false),
        store.getCredentialState(),
    )

    // Case 2: initial commit fails directory sync and verified clear succeeds -> CommitOutcome.Failed, NotConfigured
    assertTrue(store.deleteAllStrict())
    events.clear()
    fileBackend.failNextDirSync = true
    val op3 = store.beginSaveOperation()!!
    keystore.regenerateSlot(op3.pendingAlias)
    assertEquals(
        CommitOutcome.Failed,
        store.commitNewCredentials(op3.opGen, "https://init.tailnet.ts.net", op3.pendingAlias, "iv3", "ct3"),
    )
    assertTrue(store.completeOperation(op3.opGen))
    assertEquals(CredentialState(serverUrl = null, hasKey = false, incomplete = false), store.getCredentialState())
  }

  @Test
  fun directorySyncFailureThenRollbackWriteFailurePreservesRecoverablePreviousPair() {
    val events = mutableListOf<String>()
    val file = File(tempFolder.root, "spawnea_credentials.props")
    val fileBackend = RecordingAtomicFileBackend(events = events)
    val persistence = AtomicRecordFilePersistence(file, fileBackend)
    val keystore = FakeKeystoreBackend(events = events)
    val store = SpawneaCredentialStore(persistence, keystore, SLOT_A, SLOT_B)

    // Seed valid initial pair in SLOT_A
    val op1 = store.beginSaveOperation()!!
    keystore.regenerateSlot(op1.pendingAlias)
    val oldRecord = CredentialRecord("https://old.tailnet.ts.net", SLOT_A, "iv1", "ct1")
    assertEquals(
        CommitOutcome.Succeeded,
        store.commitNewCredentials(op1.opGen, oldRecord.serverUrl, op1.pendingAlias, oldRecord.ivB64, oldRecord.ciphertextB64),
    )
    assertTrue(store.completeOperation(op1.opGen))
    events.clear()

    // Double failure: post-rename fsync_dir fails, then rollback temp-file creation fails
    fileBackend.failNextDirSync = true
    fileBackend.failNextTempOpenAfterDirSyncFailure = true
    val op2 = store.beginSaveOperation()!!
    assertEquals(SLOT_B, op2.pendingAlias)
    keystore.regenerateSlot(op2.pendingAlias)

    assertEquals(
        CommitOutcome.Uncertain,
        store.commitNewCredentials(op2.opGen, "https://new.tailnet.ts.net", op2.pendingAlias, "iv2", "ct2"),
    )
    assertTrue(events.contains("open_temp_failed"))

    // Cancel/fail callback cleanup and subsequent status reads must NEVER delete either alias
    assertTrue(store.cancelOrFailSaveOperation(op2.opGen, op2.pendingAlias))
    assertTrue(keystore.containsAlias(SLOT_A))
    assertTrue(keystore.containsAlias(SLOT_B))
    assertTrue(keystore.strictDeletes.isEmpty())

    val statusRead = store.getCredentialState()
    assertTrue(statusRead.hasKey)
    assertFalse(statusRead.incomplete)
    assertNotNull(store.getActiveRecordForRead())
    assertTrue(keystore.containsAlias(SLOT_A))
    assertTrue(keystore.containsAlias(SLOT_B))
    assertTrue(keystore.strictDeletes.isEmpty())

    // Simulated restart with newer metadata (SLOT_B) on disk yields usable pair whose alias exists
    val restartedNewer = SpawneaCredentialStore(
        AtomicRecordFilePersistence(file, RecordingAtomicFileBackend()),
        keystore,
        SLOT_A,
        SLOT_B,
    )
    val newerState = restartedNewer.getCredentialState()
    assertEquals(CredentialState("https://new.tailnet.ts.net", hasKey = true, incomplete = false), newerState)
    assertEquals(SLOT_B, restartedNewer.getActiveRecordForRead()?.activeAlias)
    assertTrue(keystore.containsAlias(SLOT_B))

    // Simulated power-loss restart restoring older metadata (SLOT_A) also yields usable pair whose alias still exists
    assertTrue(
        AtomicRecordFilePersistence(file, RecordingAtomicFileBackend()).write(oldRecord),
    )
    val restartedOlder = SpawneaCredentialStore(
        AtomicRecordFilePersistence(file, RecordingAtomicFileBackend()),
        keystore,
        SLOT_A,
        SLOT_B,
    )
    val olderState = restartedOlder.getCredentialState()
    assertEquals(CredentialState("https://old.tailnet.ts.net", hasKey = true, incomplete = false), olderState)
    assertEquals(SLOT_A, restartedOlder.getActiveRecordForRead()?.activeAlias)
    assertTrue(keystore.containsAlias(SLOT_A))
    assertTrue(keystore.containsAlias(SLOT_B))
  }

  @Test
  fun nextSaveRegeneratesOnlyInactiveSlotAndPreservesActiveSlot() {
    val events = mutableListOf<String>()
    val file = File(tempFolder.root, "spawnea_credentials.props")
    val fileBackend = RecordingAtomicFileBackend(events = events)
    val persistence = AtomicRecordFilePersistence(file, fileBackend)
    val keystore = FakeKeystoreBackend(events = events)
    val store = SpawneaCredentialStore(persistence, keystore, SLOT_A, SLOT_B)

    // Save 1 activates SLOT_A
    val op1 = store.beginSaveOperation()!!
    assertEquals(SLOT_A, op1.pendingAlias)
    keystore.regenerateSlot(op1.pendingAlias)
    assertEquals(
        CommitOutcome.Succeeded,
        store.commitNewCredentials(op1.opGen, "https://one.tailnet.ts.net", op1.pendingAlias, "iv1", "ct1"),
    )
    assertTrue(store.completeOperation(op1.opGen))

    // Save 2 targets inactive SLOT_B and activates SLOT_B (SLOT_A untouched)
    events.clear()
    val op2 = store.beginSaveOperation()!!
    assertEquals(SLOT_B, op2.pendingAlias)
    keystore.regenerateSlot(op2.pendingAlias)
    assertTrue(keystore.containsAlias(SLOT_A))
    assertEquals(
        CommitOutcome.Succeeded,
        store.commitNewCredentials(op2.opGen, "https://two.tailnet.ts.net", op2.pendingAlias, "iv2", "ct2"),
    )
    assertTrue(store.completeOperation(op2.opGen))
    assertFalse(events.contains("regenerate_slot:$SLOT_A"))
    assertTrue(events.contains("regenerate_slot:$SLOT_B"))

    // Save 3 (with SLOT_B active) targets ONLY inactive SLOT_A, leaving active SLOT_B intact
    events.clear()
    val op3 = store.beginSaveOperation()!!
    assertEquals(SLOT_A, op3.pendingAlias)
    keystore.regenerateSlot(op3.pendingAlias)
    assertTrue(keystore.containsAlias(SLOT_B))
    assertEquals(
        CommitOutcome.Succeeded,
        store.commitNewCredentials(op3.opGen, "https://three.tailnet.ts.net", op3.pendingAlias, "iv3", "ct3"),
    )
    assertTrue(store.completeOperation(op3.opGen))
    assertTrue(events.contains("regenerate_slot:$SLOT_A"))
    assertFalse(events.contains("regenerate_slot:$SLOT_B"))
    assertEquals(SLOT_A, store.getActiveRecordForRead()?.activeAlias)
    assertTrue(keystore.containsAlias(SLOT_A))
    assertTrue(keystore.containsAlias(SLOT_B))
  }

  companion object {
    private const val SLOT_A = "com.growthpush.spawneamobile.api_key.slot_a"
    private const val SLOT_B = "com.growthpush.spawneamobile.api_key.slot_b"
  }
}
