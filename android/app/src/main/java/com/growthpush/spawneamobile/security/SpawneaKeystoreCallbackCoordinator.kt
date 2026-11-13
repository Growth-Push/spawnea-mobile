package com.growthpush.spawneamobile.security

import android.security.keystore.KeyPermanentlyInvalidatedException
import java.nio.charset.StandardCharsets
import java.security.GeneralSecurityException
import javax.crypto.Cipher

internal interface OperationResultSink {
  fun resolveBoolean(value: Boolean)
  fun resolveString(value: String)
  fun reject(code: String, message: String)
}

internal interface Base64Codec {
  fun encodeNoWrap(bytes: ByteArray): String
  fun decodeNoWrap(value: String): ByteArray
}

/**
 * Coordinates bridge callback execution and generation-checked state
 * releases between [SpawneaKeystoreModule] and [SpawneaCredentialStore].
 */
internal class SpawneaKeystoreCallbackCoordinator(
    private val credentialStore: SpawneaCredentialStore,
    private val base64Codec: Base64Codec,
    private val onClearLegacyPrefs: () -> Unit = {},
) {
  private val promptLock = Any()
  private var activeSink: OperationResultSink? = null
  private var activeCancelHook: (() -> Unit)? = null
  private var activePromptGeneration: Long = 0L

  fun registerActiveOperation(opGen: Long, sink: OperationResultSink) {
    synchronized(promptLock) {
      activePromptGeneration = opGen
      activeSink = sink
      activeCancelHook = null
    }
  }

  fun attachCancelHookIfCurrent(opGen: Long, onCancel: () -> Unit): Boolean {
    synchronized(promptLock) {
      if (!credentialStore.isOperationCurrent(opGen) || activePromptGeneration != opGen) {
        return false
      }
      activeCancelHook = onCancel
      return true
    }
  }

  fun onInvalidatedByDelete(): Pair<OperationResultSink?, (() -> Unit)?> {
    synchronized(promptLock) {
      val cancelHook = activeCancelHook
      val sink = activeSink
      activeCancelHook = null
      activeSink = null
      activePromptGeneration = 0L
      return Pair(sink, cancelHook)
    }
  }

  fun handleStalePrePromptCheck(opGen: Long): Boolean =
      !credentialStore.isOperationCurrent(opGen)

  fun onSaveInitFailed(
      opGen: Long?,
      pendingAlias: String?,
      fallbackSink: OperationResultSink,
  ) {
    if (opGen != null && pendingAlias != null) {
      failSaveAndReleaseSink(opGen, pendingAlias)?.reject(
          "E_STORAGE_ERROR",
          "Failed to initialize Android Keystore key",
      )
      return
    }
    if (opGen != null) {
      claimOperationSink(opGen)?.reject(
          "E_STORAGE_ERROR",
          "Failed to initialize Android Keystore key",
      )
      return
    }
    fallbackSink.reject("E_STORAGE_ERROR", "Failed to initialize Android Keystore key")
  }

  fun onSaveSucceeded(
      opGen: Long,
      pendingAlias: String,
      serverUrl: String,
      rawApiKey: String,
      unlockedCipher: Cipher?,
  ) {
    if (!credentialStore.isOperationCurrent(opGen)) {
      return
    }
    if (unlockedCipher == null) {
      failSaveAndReleaseSink(opGen, pendingAlias)?.reject(
          "E_STORAGE_ERROR",
          "Authenticated cryptographic cipher was not returned",
      )
      return
    }

    val plaintextBytes = rawApiKey.toByteArray(StandardCharsets.UTF_8)
    try {
      val ciphertext = unlockedCipher.doFinal(plaintextBytes)
      val iv = unlockedCipher.iv
      val outcome =
          credentialStore.commitNewCredentials(
              opGen = opGen,
              serverUrl = serverUrl,
              pendingAlias = pendingAlias,
              ivB64 = base64Codec.encodeNoWrap(iv),
              ciphertextB64 = base64Codec.encodeNoWrap(ciphertext),
          )
      when (outcome) {
        is CommitOutcome.Succeeded -> {
          onClearLegacyPrefs()
          claimOperationSink(opGen)?.resolveBoolean(true)
        }
        is CommitOutcome.StaleOperation -> {
          // Operation was invalidated before commit; newer owners keep their slot.
        }
        is CommitOutcome.Uncertain -> {
          failSaveAndReleaseSink(opGen, pendingAlias)?.reject(
              "E_COMMIT_UNCERTAIN",
              "Could not verify which configuration is saved on disk",
          )
        }
        is CommitOutcome.Failed,
        is CommitOutcome.NotConfigured -> {
          failSaveAndReleaseSink(opGen, pendingAlias)?.reject(
              "E_STORAGE_ERROR",
              "Failed to persist encrypted credentials",
          )
        }
      }
    } catch (_: KeyPermanentlyInvalidatedException) {
      failSaveAndReleaseSink(opGen, pendingAlias)?.reject(
          "E_AUTH_INVALIDATED",
          "Keystore key invalidated",
      )
    } catch (_: GeneralSecurityException) {
      failSaveAndReleaseSink(opGen, pendingAlias)?.reject(
          "E_STORAGE_ERROR",
          "Failed to encrypt API key",
      )
    } finally {
      plaintextBytes.fill(0)
    }
  }

  fun onSaveError(opGen: Long, pendingAlias: String, mappedErrorCode: String) {
    val pendingSink = failSaveAndReleaseSink(opGen, pendingAlias) ?: return
    pendingSink.reject(mappedErrorCode, mappedErrorCode)
  }

  fun onSavePromptSetupFailed(opGen: Long, pendingAlias: String) {
    failSaveAndReleaseSink(opGen, pendingAlias)?.reject(
        "E_STORAGE_ERROR",
        "Failed to present biometric prompt",
    )
  }

  fun onReadSucceeded(
      opGen: Long,
      ciphertext: ByteArray,
      unlockedCipher: Cipher?,
  ) {
    if (!credentialStore.isOperationCurrent(opGen)) {
      return
    }
    if (unlockedCipher == null) {
      failReadAndReleaseSink(opGen)?.reject(
          "E_STORAGE_ERROR",
          "Authenticated cryptographic cipher was not returned",
      )
      return
    }

    var plaintextBytes: ByteArray? = null
    try {
      plaintextBytes = unlockedCipher.doFinal(ciphertext)
      val decrypted = String(plaintextBytes, StandardCharsets.UTF_8)
      val pendingSink = claimOperationSink(opGen) ?: return
      pendingSink.resolveString(decrypted)
    } catch (_: KeyPermanentlyInvalidatedException) {
      failReadAndReleaseSink(opGen)?.reject(
          "E_AUTH_INVALIDATED",
          "Keystore key permanently invalidated",
      )
    } catch (_: GeneralSecurityException) {
      failReadAndReleaseSink(opGen)?.reject(
          "E_STORAGE_ERROR",
          "Failed to decrypt saved API key",
      )
    } finally {
      plaintextBytes?.fill(0)
    }
  }

  fun onReadError(opGen: Long, mappedErrorCode: String) {
    val pendingSink = failReadAndReleaseSink(opGen) ?: return
    pendingSink.reject(mappedErrorCode, mappedErrorCode)
  }

  fun onReadPromptSetupFailed(opGen: Long) {
    failReadAndReleaseSink(opGen)?.reject(
        "E_STORAGE_ERROR",
        "Failed to present biometric prompt",
    )
  }

  fun claimOperationSink(opGen: Long): OperationResultSink? {
    if (!credentialStore.completeOperation(opGen)) {
      return null
    }
    return releaseOperationSink(opGen)
  }

  private fun failSaveAndReleaseSink(opGen: Long, pendingAlias: String): OperationResultSink? {
    if (!credentialStore.cancelOrFailSaveOperation(opGen, pendingAlias)) {
      return null
    }
    return releaseOperationSink(opGen)
  }

  private fun failReadAndReleaseSink(opGen: Long): OperationResultSink? {
    if (!credentialStore.cancelOrFailReadOperation(opGen)) {
      return null
    }
    return releaseOperationSink(opGen)
  }

  private fun releaseOperationSink(opGen: Long): OperationResultSink? {
    synchronized(promptLock) {
      if (activePromptGeneration != opGen) {
        return null
      }
      val claimed = activeSink
      activeSink = null
      activeCancelHook = null
      activePromptGeneration = 0L
      return claimed
    }
  }
}
