package com.growthpush.spawneamobile.security

import java.nio.charset.StandardCharsets
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SpawneaKeystoreCallbackTest {
  private class RecordingSink : OperationResultSink {
    var resolvedBoolean: Boolean? = null
    var resolvedString: String? = null
    var rejectedCode: String? = null
    var rejectedMessage: String? = null

    override fun resolveBoolean(value: Boolean) {
      resolvedBoolean = value
    }

    override fun resolveString(value: String) {
      resolvedString = value
    }

    override fun reject(code: String, message: String) {
      rejectedCode = code
      rejectedMessage = message
    }
  }

  private class InMemoryPersistence : MetadataPersistence {
    var record: CredentialRecord? = null
    var alwaysFailWrite: Boolean = false

    override fun hasPersistedData(): Boolean = record != null

    override fun read(): MetadataReadResult {
      val current = record ?: return MetadataReadResult.Empty
      return MetadataReadResult.Valid(current)
    }

    override fun write(record: CredentialRecord): Boolean {
      if (alwaysFailWrite) {
        return false
      }
      this.record = record
      return true
    }

    override fun clear(): Boolean {
      record = null
      return true
    }
  }

  private class TrackingKeystoreBackend : KeystoreSlotBackend {
    val aliases = linkedSetOf<String>()
    val strictDeletes = mutableListOf<String>()

    override fun containsAlias(alias: String): Boolean = aliases.contains(alias)

    override fun deleteAliasStrict(alias: String) {
      strictDeletes.add(alias)
      aliases.remove(alias)
    }
  }

  private val jvmBase64 =
      object : Base64Codec {
        override fun encodeNoWrap(bytes: ByteArray): String =
            Base64.getEncoder().encodeToString(bytes)

        override fun decodeNoWrap(value: String): ByteArray =
            Base64.getDecoder().decode(value)
      }

  private fun newCoordinator():
      Triple<SpawneaCredentialStore, TrackingKeystoreBackend, SpawneaKeystoreCallbackCoordinator> {
    val persistence = InMemoryPersistence()
    val keystore = TrackingKeystoreBackend()
    val store = SpawneaCredentialStore(persistence, keystore, SLOT_A, SLOT_B)
    val coordinator =
        SpawneaKeystoreCallbackCoordinator(
            credentialStore = store,
            base64Codec = jvmBase64,
        )
    return Triple(store, keystore, coordinator)
  }

  private fun generateAesKey(): SecretKey {
    val gen = KeyGenerator.getInstance("AES")
    gen.init(256)
    return gen.generateKey()
  }

  @Test
  fun missingCryptoObjectDuringSaveRejectsStorageErrorAndPersistsNothing() {
    val (store, keystore, coordinator) = newCoordinator()
    val op = store.beginSaveOperation()!!
    val sink = RecordingSink()
    coordinator.registerActiveOperation(op.opGen, sink)
    keystore.aliases.add(op.pendingAlias)

    coordinator.onSaveSucceeded(
        opGen = op.opGen,
        pendingAlias = op.pendingAlias,
        serverUrl = "https://desktop.tailnet.ts.net:5757",
        rawApiKey = "secret-token",
        unlockedCipher = null,
    )

    assertEquals("E_STORAGE_ERROR", sink.rejectedCode)
    assertNull(sink.resolvedBoolean)
    assertTrue(keystore.strictDeletes.isEmpty())
    assertEquals(CredentialState(serverUrl = null, hasKey = false, incomplete = false), store.getCredentialState())
    assertFalse(store.isOperationCurrent(op.opGen))
  }

  @Test
  fun missingCryptoObjectDuringReadRejectsAndReturnsNoPlaintext() {
    val (store, keystore, coordinator) = newCoordinator()
    val key = generateAesKey()
    val encCipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
      init(Cipher.ENCRYPT_MODE, key)
    }
    val ciphertext = encCipher.doFinal("top-secret-key".toByteArray(StandardCharsets.UTF_8))

    val saveOp = store.beginSaveOperation()!!
    keystore.aliases.add(saveOp.pendingAlias)
    assertEquals(
        CommitOutcome.Succeeded,
        store.commitNewCredentials(
            saveOp.opGen,
            "https://desktop.tailnet.ts.net:5757",
            saveOp.pendingAlias,
            jvmBase64.encodeNoWrap(encCipher.iv),
            jvmBase64.encodeNoWrap(ciphertext),
        ),
    )
    store.completeOperation(saveOp.opGen)

    val readGen = store.beginReadOperation()!!
    val readSink = RecordingSink()
    coordinator.registerActiveOperation(readGen, readSink)

    coordinator.onReadSucceeded(
        opGen = readGen,
        ciphertext = ciphertext,
        unlockedCipher = null,
    )

    assertEquals("E_STORAGE_ERROR", readSink.rejectedCode)
    assertNull(readSink.resolvedString)
    assertFalse(store.isOperationCurrent(readGen))
  }

  @Test
  fun delayedOldSaveErrorCallbackAfterDeleteAndSlotReusePreservesNewPendingAndCommittedAliases() {
    val (store, keystore, coordinator) = newCoordinator()

    // Case 1: old save in SLOT_A waits -> deleted -> new save reuses SLOT_A (pending)
    val oldSave = store.beginSaveOperation()!!
    assertEquals(SLOT_A, oldSave.pendingAlias)
    val oldSink = RecordingSink()
    coordinator.registerActiveOperation(oldSave.opGen, oldSink)
    keystore.aliases.add(SLOT_A)

    assertTrue(
        store.deleteAllStrict {
          val (sink, _) = coordinator.onInvalidatedByDelete()
          sink?.reject("E_AUTH_CANCELED", "interrupted")
        },
    )
    assertEquals("E_AUTH_CANCELED", oldSink.rejectedCode)

    val newPendingSave = store.beginSaveOperation()!!
    assertEquals(SLOT_A, newPendingSave.pendingAlias)
    val newPendingSink = RecordingSink()
    coordinator.registerActiveOperation(newPendingSave.opGen, newPendingSink)
    keystore.aliases.add(SLOT_A)

    // Delayed error callback from oldSave arrives for SLOT_A while newPendingSave owns SLOT_A.
    coordinator.onSaveError(oldSave.opGen, oldSave.pendingAlias, "E_AUTH_CANCELED")

    assertTrue("New pending SLOT_A must still exist", keystore.containsAlias(SLOT_A))
    assertTrue("New save op must still be active", store.isOperationCurrent(newPendingSave.opGen))
    assertNull(newPendingSink.rejectedCode)

    // Complete newPendingSave -> commits SLOT_A cleanly.
    val aesKey = generateAesKey()
    val encCipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, aesKey) }
    coordinator.onSaveSucceeded(
        opGen = newPendingSave.opGen,
        pendingAlias = newPendingSave.pendingAlias,
        serverUrl = "https://new-server.tailnet.ts.net",
        rawApiKey = "fresh-api-key",
        unlockedCipher = encCipher,
    )
    assertEquals(true, newPendingSink.resolvedBoolean)
    assertTrue(keystore.containsAlias(SLOT_A))
    assertEquals(
        CredentialState("https://new-server.tailnet.ts.net", hasKey = true, incomplete = false),
        store.getCredentialState(),
    )

    // Case 2: delayed error callback from oldSave arrives AFTER SLOT_A was already committed.
    coordinator.onSaveError(oldSave.opGen, oldSave.pendingAlias, "E_AUTH_CANCELED")

    assertTrue("Committed SLOT_A must remain in Keystore", keystore.containsAlias(SLOT_A))
    assertEquals(
        CredentialState("https://new-server.tailnet.ts.net", hasKey = true, incomplete = false),
        store.getCredentialState(),
    )
  }

  @Test
  fun delayedOldSaveSuccessCallbackAfterDeleteAndSlotReusePreservesNewPendingAndCommittedAliases() {
    val (store, keystore, coordinator) = newCoordinator()
    val oldKey = generateAesKey()
    val newKey = generateAesKey()

    // Old save begins in SLOT_A, then deleted before callback fires.
    val oldSave = store.beginSaveOperation()!!
    assertEquals(SLOT_A, oldSave.pendingAlias)
    val oldSink = RecordingSink()
    coordinator.registerActiveOperation(oldSave.opGen, oldSink)
    keystore.aliases.add(SLOT_A)

    assertTrue(
        store.deleteAllStrict {
          val (sink, _) = coordinator.onInvalidatedByDelete()
          sink?.reject("E_AUTH_CANCELED", "interrupted")
        },
    )

    // New save begins and reuses SLOT_A.
    val newSave = store.beginSaveOperation()!!
    assertEquals(SLOT_A, newSave.pendingAlias)
    val newSink = RecordingSink()
    coordinator.registerActiveOperation(newSave.opGen, newSink)
    keystore.aliases.add(SLOT_A)

    // Delayed old pre-prompt check AND delayed old success callback fire while newSave owns SLOT_A.
    assertTrue(coordinator.handleStalePrePromptCheck(oldSave.opGen))
    assertTrue("New pending SLOT_A must survive old pre-prompt stale check", keystore.containsAlias(SLOT_A))

    val oldCipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, oldKey) }
    coordinator.onSaveSucceeded(
        opGen = oldSave.opGen,
        pendingAlias = oldSave.pendingAlias,
        serverUrl = "https://stale.tailnet.ts.net",
        rawApiKey = "stale-key",
        unlockedCipher = oldCipher,
    )
    assertTrue("New pending SLOT_A must survive delayed old save-success", keystore.containsAlias(SLOT_A))
    assertTrue(store.isOperationCurrent(newSave.opGen))
    assertNull(store.getActiveRecordForRead())

    // New save succeeds and commits SLOT_A.
    val newCipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, newKey) }
    coordinator.onSaveSucceeded(
        opGen = newSave.opGen,
        pendingAlias = newSave.pendingAlias,
        serverUrl = "https://fresh.tailnet.ts.net",
        rawApiKey = "fresh-key",
        unlockedCipher = newCipher,
    )
    assertEquals(true, newSink.resolvedBoolean)
    assertNotNull(store.getActiveRecordForRead())

    // Delayed old save-success arrives AGAIN after SLOT_A committed.
    val oldCipherLate = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, oldKey) }
    coordinator.onSaveSucceeded(
        opGen = oldSave.opGen,
        pendingAlias = oldSave.pendingAlias,
        serverUrl = "https://stale.tailnet.ts.net",
        rawApiKey = "stale-key",
        unlockedCipher = oldCipherLate,
    )

    assertTrue("Committed SLOT_A must still exist", keystore.containsAlias(SLOT_A))
    assertEquals("https://fresh.tailnet.ts.net", store.getCredentialState().serverUrl)
    assertTrue(store.getCredentialState().hasKey)
  }

  @Test
  fun uncertainCommitOutcomeRejectsCommitUncertainAndPreservesBothAliases() {
    val persistence = InMemoryPersistence()
    val keystore = TrackingKeystoreBackend()
    val store = SpawneaCredentialStore(persistence, keystore, SLOT_A, SLOT_B)
    val coordinator =
        SpawneaKeystoreCallbackCoordinator(
            credentialStore = store,
            base64Codec = jvmBase64,
        )

    // Seed SLOT_A
    val op1 = store.beginSaveOperation()!!
    keystore.aliases.add(op1.pendingAlias)
    assertEquals(
        CommitOutcome.Succeeded,
        store.commitNewCredentials(op1.opGen, "https://old.tailnet.ts.net", op1.pendingAlias, "iv1", "ct1"),
    )
    assertTrue(store.completeOperation(op1.opGen))

    // Start replacement in SLOT_B and fail both commit write and rollback write
    val op2 = store.beginSaveOperation()!!
    assertEquals(SLOT_B, op2.pendingAlias)
    val sink2 = RecordingSink()
    coordinator.registerActiveOperation(op2.opGen, sink2)
    keystore.aliases.add(op2.pendingAlias)
    persistence.alwaysFailWrite = true

    val encCipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
      init(Cipher.ENCRYPT_MODE, generateAesKey())
    }
    coordinator.onSaveSucceeded(
        opGen = op2.opGen,
        pendingAlias = op2.pendingAlias,
        serverUrl = "https://new.tailnet.ts.net",
        rawApiKey = "new-secret-key",
        unlockedCipher = encCipher,
    )

    assertEquals("E_COMMIT_UNCERTAIN", sink2.rejectedCode)
    assertNull(sink2.resolvedBoolean)
    assertFalse(store.isOperationCurrent(op2.opGen))
    assertTrue(keystore.containsAlias(SLOT_A))
    assertTrue(keystore.containsAlias(SLOT_B))
    assertTrue(keystore.strictDeletes.isEmpty())
  }

  companion object {
    private const val SLOT_A = "com.growthpush.spawneamobile.api_key.slot_a"
    private const val SLOT_B = "com.growthpush.spawneamobile.api_key.slot_b"
  }
}
