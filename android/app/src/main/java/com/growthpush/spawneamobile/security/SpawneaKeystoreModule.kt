package com.growthpush.spawneamobile.security

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Android Keystore + BiometricPrompt (BIOMETRIC_STRONG + CryptoObject) storage
 * for the Spawnea server URL and API key.
 *
 * Policy enforced:
 * - AES-256-GCM key in AndroidKeyStore with setUserAuthenticationRequired(true)
 * - Per-use biometric authentication (validity 0 + AUTH_BIOMETRIC_STRONG on API 30+,
 *   validity -1 below API 30)
 * - Invalidated on biometric enrollment changes (setInvalidatedByBiometricEnrollment(true))
 * - BiometricPrompt with BIOMETRIC_STRONG only (no device credential / PIN fallback)
 * - Fail closed if AuthenticationResult.cryptoObject?.cipher is null
 * - Server URL and encrypted key slot metadata stored in one durable atomic record
 * - Operation generation serialization between biometric prompts and strict deletion
 */
class SpawneaKeystoreModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  private class PromiseResultSink(private val promise: Promise) : OperationResultSink {
    override fun resolveBoolean(value: Boolean) = promise.resolve(value)

    override fun resolveString(value: String) = promise.resolve(value)

    override fun reject(code: String, message: String) = promise.reject(code, message)
  }

  private val keystoreBackend =
      object : KeystoreSlotBackend {
        override fun containsAlias(alias: String): Boolean = loadKeyStore().containsAlias(alias)

        override fun deleteAliasStrict(alias: String) {
          val keyStore = loadKeyStore()
          if (keyStore.containsAlias(alias)) {
            keyStore.deleteEntry(alias)
          }
          val verifyStore = loadKeyStore()
          if (verifyStore.containsAlias(alias)) {
            throw IllegalStateException("Keystore alias still present after strict deletion")
          }
        }
      }

  private val androidBase64Codec =
      object : Base64Codec {
        override fun encodeNoWrap(bytes: ByteArray): String =
            Base64.encodeToString(bytes, Base64.NO_WRAP)

        override fun decodeNoWrap(value: String): ByteArray =
            Base64.decode(value, Base64.NO_WRAP)
      }

  private val credentialStore: SpawneaCredentialStore by lazy {
    val persistence =
        AtomicRecordFilePersistence(File(reactContext.noBackupFilesDir, METADATA_FILE_NAME))
    SpawneaCredentialStore(
        persistence = persistence,
        keystore = keystoreBackend,
        aliasSlotA = ALIAS_SLOT_A,
        aliasSlotB = ALIAS_SLOT_B,
    )
  }

  private val callbackCoordinator: SpawneaKeystoreCallbackCoordinator by lazy {
    SpawneaKeystoreCallbackCoordinator(
        credentialStore = credentialStore,
        base64Codec = androidBase64Codec,
        onClearLegacyPrefs = { clearLegacyPrefsBestEffort() },
    )
  }

  override fun getName(): String = NAME

  @ReactMethod
  fun getCapability(promise: Promise) {
    try {
      val manager = BiometricManager.from(reactContext)
      val status = manager.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG)
      val result = Arguments.createMap()
      when (status) {
        BiometricManager.BIOMETRIC_SUCCESS -> {
          result.putBoolean("biometryAvailable", true)
          result.putString("biometryType", "Fingerprint")
          result.putString("status", "available")
        }
        BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED -> {
          result.putBoolean("biometryAvailable", false)
          result.putNull("biometryType")
          result.putString("status", "none_enrolled")
        }
        else -> {
          result.putBoolean("biometryAvailable", false)
          result.putNull("biometryType")
          result.putString("status", "unavailable")
        }
      }
      promise.resolve(result)
    } catch (_: Exception) {
      promise.reject("E_STORAGE_ERROR", "Failed to query biometric capability")
    }
  }

  @ReactMethod
  fun getCredentialState(promise: Promise) {
    try {
      val state = credentialStore.getCredentialState()
      val result = Arguments.createMap()
      if (state.serverUrl != null) {
        result.putString("serverUrl", state.serverUrl)
      } else {
        result.putNull("serverUrl")
      }
      result.putBoolean("hasKey", state.hasKey)
      result.putBoolean("incomplete", state.incomplete)
      promise.resolve(result)
    } catch (_: Exception) {
      val fallback = Arguments.createMap()
      fallback.putNull("serverUrl")
      fallback.putBoolean("hasKey", false)
      fallback.putBoolean("incomplete", true)
      promise.resolve(fallback)
    }
  }

  @ReactMethod
  fun hasKey(promise: Promise) {
    try {
      promise.resolve(credentialStore.getCredentialState().hasKey)
    } catch (_: Exception) {
      promise.resolve(false)
    }
  }

  @ReactMethod
  fun saveCredentials(
      serverUrl: String,
      rawApiKey: String,
      promptTitle: String,
      promptSubtitle: String,
      negativeButtonText: String,
      promise: Promise,
  ) {
    val trimmedUrl = serverUrl.trim()
    if (trimmedUrl.isEmpty()) {
      promise.reject("E_INVALID_URL", "Server URL is required")
      return
    }
    val trimmedKey = rawApiKey.trim()
    if (trimmedKey.isEmpty()) {
      promise.reject("E_EMPTY_KEY", "API key is required")
      return
    }

    val capabilityError = checkStrongBiometricsReady()
    if (capabilityError != null) {
      promise.reject(capabilityError, capabilityError)
      return
    }

    val activity = reactContext.currentActivity as? FragmentActivity
    if (activity == null) {
      promise.reject("E_ACTIVITY_UNAVAILABLE", "No active activity for biometric prompt")
      return
    }

    var opGen: Long? = null
    var pendingAlias: String? = null
    val cipher: Cipher
    try {
      val started = credentialStore.beginSaveOperation()
      if (started == null) {
        promise.reject("E_AUTH_IN_PROGRESS", "Biometric prompt already active")
        return
      }
      opGen = started.opGen
      pendingAlias = started.pendingAlias
      registerActiveOperation(opGen, promise)

      regenerateInactiveSlotBestEffort(pendingAlias)
      val secretKey = generateStrongBiometricKey(pendingAlias)
      cipher = Cipher.getInstance(TRANSFORMATION)
      cipher.init(Cipher.ENCRYPT_MODE, secretKey)
    } catch (_: Exception) {
      callbackCoordinator.onSaveInitFailed(opGen, pendingAlias, PromiseResultSink(promise))
      return
    }

    val activeOpGen = opGen ?: return
    val activePendingAlias = pendingAlias ?: return

    UiThreadUtil.runOnUiThread {
      if (callbackCoordinator.handleStalePrePromptCheck(activeOpGen)) {
        return@runOnUiThread
      }
      try {
        val executor = ContextCompat.getMainExecutor(activity)
        val prompt =
            BiometricPrompt(
                activity,
                executor,
                object : BiometricPrompt.AuthenticationCallback() {
                  override fun onAuthenticationSucceeded(
                      result: BiometricPrompt.AuthenticationResult
                  ) {
                    callbackCoordinator.onSaveSucceeded(
                        opGen = activeOpGen,
                        pendingAlias = activePendingAlias,
                        serverUrl = trimmedUrl,
                        rawApiKey = trimmedKey,
                        unlockedCipher = result.cryptoObject?.cipher,
                    )
                  }

                  override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    callbackCoordinator.onSaveError(
                        opGen = activeOpGen,
                        pendingAlias = activePendingAlias,
                        mappedErrorCode = mapPromptErrorCode(errorCode),
                    )
                  }

                  override fun onAuthenticationFailed() {
                    // Prompt stays open until biometric succeeds, cancels, or locks out.
                  }
                },
            )

        val attached =
            callbackCoordinator.attachCancelHookIfCurrent(activeOpGen) {
              try {
                prompt.cancelAuthentication()
              } catch (_: Exception) {
                // Best-effort UI prompt dismissal after operation invalidation.
              }
            }
        if (!attached) {
          return@runOnUiThread
        }

        val promptInfo =
            BiometricPrompt.PromptInfo.Builder()
                .setTitle(promptTitle)
                .setSubtitle(promptSubtitle)
                .setNegativeButtonText(negativeButtonText)
                .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
                .build()

        prompt.authenticate(promptInfo, BiometricPrompt.CryptoObject(cipher))
      } catch (_: Exception) {
        callbackCoordinator.onSavePromptSetupFailed(activeOpGen, activePendingAlias)
      }
    }
  }

  @ReactMethod
  fun updateServerUrl(serverUrl: String, promise: Promise) {
    val trimmedUrl = serverUrl.trim()
    if (trimmedUrl.isEmpty()) {
      promise.reject("E_INVALID_URL", "Server URL is required")
      return
    }
    try {
      when (credentialStore.updateServerUrl(trimmedUrl)) {
        is CommitOutcome.Succeeded -> {
          clearLegacyPrefsBestEffort()
          promise.resolve(true)
        }
        is CommitOutcome.NotConfigured ->
            promise.reject("E_NOT_CONFIGURED", "No API key is saved on this device")
        is CommitOutcome.Uncertain ->
            promise.reject(
                "E_COMMIT_UNCERTAIN",
                "Could not verify which configuration is saved on disk",
            )
        is CommitOutcome.Failed,
        is CommitOutcome.StaleOperation ->
            promise.reject("E_STORAGE_ERROR", "Failed to persist server URL")
      }
    } catch (_: Exception) {
      promise.reject("E_STORAGE_ERROR", "Failed to persist server URL")
    }
  }

  @ReactMethod
  fun readKey(
      promptTitle: String,
      promptSubtitle: String,
      negativeButtonText: String,
      promise: Promise,
  ) {
    val record = credentialStore.getActiveRecordForRead()
    if (record == null) {
      promise.reject("E_NOT_CONFIGURED", "No API key is saved on this device")
      return
    }

    val capabilityError = checkStrongBiometricsReady()
    if (capabilityError != null) {
      promise.reject(capabilityError, capabilityError)
      return
    }

    val activity = reactContext.currentActivity as? FragmentActivity
    if (activity == null) {
      promise.reject("E_ACTIVITY_UNAVAILABLE", "No active activity for biometric prompt")
      return
    }

    val opGen =
        try {
          credentialStore.beginReadOperation()
        } catch (_: Exception) {
          promise.reject("E_STORAGE_ERROR", "Failed to prepare decryption cipher")
          return
        }
    if (opGen == null) {
      promise.reject("E_AUTH_IN_PROGRESS", "Biometric prompt already active")
      return
    }
    registerActiveOperation(opGen, promise)

    val iv: ByteArray
    val ciphertext: ByteArray
    val cipher: Cipher
    try {
      iv = Base64.decode(record.ivB64, Base64.NO_WRAP)
      ciphertext = Base64.decode(record.ciphertextB64, Base64.NO_WRAP)
      val keyStore = loadKeyStore()
      val secretKey = keyStore.getKey(record.activeAlias, null) as? SecretKey
      if (secretKey == null) {
        claimOperationPromise(opGen)?.reject(
            "E_NOT_CONFIGURED",
            "Saved API key entry is missing",
        )
        return
      }
      cipher = Cipher.getInstance(TRANSFORMATION)
      cipher.init(Cipher.DECRYPT_MODE, secretKey, GCMParameterSpec(GCM_TAG_BITS, iv))
    } catch (_: KeyPermanentlyInvalidatedException) {
      claimOperationPromise(opGen)?.reject(
          "E_AUTH_INVALIDATED",
          "Keystore key permanently invalidated",
      )
      return
    } catch (_: Exception) {
      claimOperationPromise(opGen)?.reject(
          "E_STORAGE_ERROR",
          "Failed to prepare decryption cipher",
      )
      return
    }

    UiThreadUtil.runOnUiThread {
      if (!credentialStore.isOperationCurrent(opGen)) {
        return@runOnUiThread
      }
      try {
        val executor = ContextCompat.getMainExecutor(activity)
        val prompt =
            BiometricPrompt(
                activity,
                executor,
                object : BiometricPrompt.AuthenticationCallback() {
                  override fun onAuthenticationSucceeded(
                      result: BiometricPrompt.AuthenticationResult
                  ) {
                    callbackCoordinator.onReadSucceeded(
                        opGen = opGen,
                        ciphertext = ciphertext,
                        unlockedCipher = result.cryptoObject?.cipher,
                    )
                  }

                  override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    callbackCoordinator.onReadError(
                        opGen = opGen,
                        mappedErrorCode = mapPromptErrorCode(errorCode),
                    )
                  }

                  override fun onAuthenticationFailed() {
                    // Prompt stays open until strong biometric succeeds, cancels, or locks out.
                  }
                },
            )

        val attached =
            callbackCoordinator.attachCancelHookIfCurrent(opGen) {
              try {
                prompt.cancelAuthentication()
              } catch (_: Exception) {
                // Best-effort UI prompt dismissal after operation invalidation.
              }
            }
        if (!attached) {
          return@runOnUiThread
        }

        val promptInfo =
            BiometricPrompt.PromptInfo.Builder()
                .setTitle(promptTitle)
                .setSubtitle(promptSubtitle)
                .setNegativeButtonText(negativeButtonText)
                .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
                .build()

        prompt.authenticate(promptInfo, BiometricPrompt.CryptoObject(cipher))
      } catch (_: Exception) {
        callbackCoordinator.onReadPromptSetupFailed(opGen)
      }
    }
  }

  @ReactMethod
  fun deleteKey(promise: Promise) {
    try {
      val deleted =
          credentialStore.deleteAllStrict(
              onInvalidatePending = {
                val (sinkToReject, cancelHook) = callbackCoordinator.onInvalidatedByDelete()
                if (cancelHook != null) {
                  UiThreadUtil.runOnUiThread { cancelHook() }
                }
                sinkToReject?.reject("E_AUTH_CANCELED", "Credential operation interrupted by delete")
              },
          )
      clearLegacyPrefsBestEffort()
      if (!deleted) {
        promise.reject("E_STORAGE_ERROR", "Failed to verify deletion of stored credentials")
        return
      }
      promise.resolve(true)
    } catch (_: Exception) {
      promise.reject("E_STORAGE_ERROR", "Failed to delete stored credentials")
    }
  }

  private fun registerActiveOperation(opGen: Long, promise: Promise) {
    callbackCoordinator.registerActiveOperation(opGen, PromiseResultSink(promise))
  }

  private fun claimOperationPromise(opGen: Long): OperationResultSink? =
      callbackCoordinator.claimOperationSink(opGen)

  private fun clearLegacyPrefsBestEffort() {
    try {
      reactContext
          .getSharedPreferences(LEGACY_PREFS_NAME, Context.MODE_PRIVATE)
          .edit()
          .clear()
          .commit()
    } catch (_: Exception) {
      // Best-effort cleanup of pre-R4 SharedPreferences.
    }
  }

  private fun loadKeyStore(): KeyStore =
      KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

  private fun regenerateInactiveSlotBestEffort(inactiveAlias: String) {
    try {
      val keyStore = loadKeyStore()
      if (keyStore.containsAlias(inactiveAlias)) {
        keyStore.deleteEntry(inactiveAlias)
      }
    } catch (_: Exception) {
      // Inactive slot is not referenced by persisted metadata; KeyGenerator overwrites on generateKey().
    }
  }

  private fun generateStrongBiometricKey(alias: String): SecretKey {
    val keyGenerator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
    val builder =
        KeyGenParameterSpec.Builder(
                alias,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(KEY_SIZE_BITS)
            .setUserAuthenticationRequired(true)
            .setInvalidatedByBiometricEnrollment(true)

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      builder.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
    } else {
      @Suppress("DEPRECATION")
      builder.setUserAuthenticationValidityDurationSeconds(-1)
    }

    keyGenerator.init(builder.build())
    return keyGenerator.generateKey()
  }

  private fun checkStrongBiometricsReady(): String? {
    val manager = BiometricManager.from(reactContext)
    return when (manager.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG)) {
      BiometricManager.BIOMETRIC_SUCCESS -> null
      BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED -> "E_BIOMETRIC_NOT_ENROLLED"
      else -> "E_BIOMETRIC_UNAVAILABLE"
    }
  }

  private fun mapPromptErrorCode(errorCode: Int): String =
      when (errorCode) {
        BiometricPrompt.ERROR_USER_CANCELED,
        BiometricPrompt.ERROR_NEGATIVE_BUTTON,
        BiometricPrompt.ERROR_CANCELED -> "E_AUTH_CANCELED"
        BiometricPrompt.ERROR_LOCKOUT -> "E_BIOMETRIC_LOCKOUT"
        BiometricPrompt.ERROR_LOCKOUT_PERMANENT -> "E_BIOMETRIC_LOCKOUT_PERMANENT"
        BiometricPrompt.ERROR_NO_BIOMETRICS -> "E_BIOMETRIC_NOT_ENROLLED"
        BiometricPrompt.ERROR_TIMEOUT -> "E_AUTH_TIMEOUT"
        BiometricPrompt.ERROR_HW_NOT_PRESENT,
        BiometricPrompt.ERROR_HW_UNAVAILABLE,
        BiometricPrompt.ERROR_NO_DEVICE_CREDENTIAL,
        BiometricPrompt.ERROR_SECURITY_UPDATE_REQUIRED -> "E_BIOMETRIC_UNAVAILABLE"
        else -> "E_AUTH_ERROR"
      }

  companion object {
    const val NAME = "SpawneaKeystore"
    private const val ANDROID_KEYSTORE = "AndroidKeyStore"
    private const val TRANSFORMATION = "AES/GCM/NoPadding"
    private const val KEY_SIZE_BITS = 256
    private const val GCM_TAG_BITS = 128

    private const val METADATA_FILE_NAME = "spawnea_credentials.props"
    private const val LEGACY_PREFS_NAME = "spawnea_keystore_prefs"

    private const val ALIAS_SLOT_A = "com.growthpush.spawneamobile.api_key.slot_a"
    private const val ALIAS_SLOT_B = "com.growthpush.spawneamobile.api_key.slot_b"
  }
}
