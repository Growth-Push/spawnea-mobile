package com.growthpush.spawneamobile.network

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.growthpush.spawneamobile.BuildConfig

/**
 * React Native bridge for SpawneaHttpTransport.
 *
 * Intentionally bypasses React Native's NetworkingModule, NetworkEventUtil,
 * and InspectorNetworkReporter so Authorization Bearer keys are never forwarded
 * to the DevTools/CDP network inspector in debug builds, and uses single-shot
 * request bodies with redirects and retries disabled.
 */
class SpawneaHttpModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  private val transport =
      SpawneaHttpTransport(
          allowCleartextLoopback = BuildConfig.DEBUG,
          onDiagnostic = { detail -> android.util.Log.w(NAME, detail) },
      )

  override fun getName(): String = NAME

  override fun getConstants(): Map<String, Any> =
      mapOf("allowDebugLoopback" to BuildConfig.DEBUG)

  @ReactMethod
  fun request(options: ReadableMap, promise: Promise) {
    val rawUrl = options.getString("url")
    val method = options.getString("method")?.uppercase() ?: "GET"
    if (rawUrl.isNullOrBlank()) {
      promise.reject("E_INVALID_URL", "Invalid URL")
      return
    }

    val timeoutMs =
        if (options.hasKey("timeoutMs") && !options.isNull("timeoutMs")) {
          options.getDouble("timeoutMs").toLong().coerceIn(1000L, 60000L)
        } else {
          SpawneaHttpTransport.DEFAULT_TIMEOUT_MS
        }

    val headers = LinkedHashMap<String, String>()
    if (options.hasKey("headers") && !options.isNull("headers")) {
      val headersMap = options.getMap("headers")
      if (headersMap != null) {
        val iterator = headersMap.keySetIterator()
        while (iterator.hasNextKey()) {
          val key = iterator.nextKey()
          val value = headersMap.getString(key)
          if (value != null) {
            headers[key] = value
          }
        }
      }
    }

    val bodyText =
        if (options.hasKey("body") && !options.isNull("body")) {
          options.getString("body")
        } else {
          null
        }

    transport.executeAsync(
        method = method,
        rawUrl = rawUrl,
        headers = headers,
        body = bodyText,
        timeoutMs = timeoutMs,
        onSuccess = { res ->
          val result = Arguments.createMap()
          result.putInt("status", res.status)
          if (res.retryAfter != null) {
            result.putString("retryAfter", res.retryAfter)
          } else {
            result.putNull("retryAfter")
          }
          result.putString("body", res.body)
          promise.resolve(result)
        },
        onError = { code ->
          android.util.Log.w(NAME, "request rejected method=$method code=$code")
          promise.reject(code, code)
        },
    )
  }

  companion object {
    const val NAME = "SpawneaHttp"
  }
}
