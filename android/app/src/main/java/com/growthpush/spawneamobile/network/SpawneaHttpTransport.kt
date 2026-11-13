package com.growthpush.spawneamobile.network

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.InterruptedIOException
import java.net.SocketTimeoutException
import java.nio.charset.StandardCharsets
import java.security.cert.CertificateException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import javax.net.ssl.SSLException
import okhttp3.Call
import okhttp3.Callback
import okhttp3.ConnectionPool
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.Response
import okio.BufferedSink

data class HttpTransportResult(
    val status: Int,
    val retryAfter: String?,
    val body: String,
)

class TransportException(
    val errorCode: String,
    message: String,
) : Exception(message)

/**
 * Single-shot JSON RequestBody so OkHttp's RetryAndFollowUpInterceptor never
 * replays non-GET requests (e.g. on 503 with Retry-After: 0 or HTTP/2 421).
 */
class OneShotJsonRequestBody(
    private val bytes: ByteArray,
) : RequestBody() {
  private val consumed = AtomicBoolean(false)

  override fun isOneShot(): Boolean = true

  override fun contentType(): MediaType = JSON_MEDIA_TYPE

  override fun contentLength(): Long = bytes.size.toLong()

  override fun writeTo(sink: BufferedSink) {
    if (!consumed.compareAndSet(false, true)) {
      throw IOException("One-shot request body already consumed")
    }
    sink.write(bytes)
  }

  companion object {
    private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
  }
}

/**
 * Pure-Kotlin OkHttp transport enforcing single-shot POSTs, pre-dispatch
 * contract limits, header safety, error-body skipping, and TLS/timeout
 * classification.
 */
class SpawneaHttpTransport(
    private val allowCleartextLoopback: Boolean,
    private val baseClient: OkHttpClient = defaultOkHttpClient(),
    private val onDiagnostic: ((String) -> Unit)? = null,
) {

  fun buildRequest(
      method: String,
      rawUrl: String,
      headers: Map<String, String>,
      body: String?,
  ): Request {
    val normalizedMethod = method.uppercase()
    if (normalizedMethod != "GET" && normalizedMethod != "POST") {
      throw TransportException("E_INVALID_METHOD", "Unsupported HTTP method")
    }

    val parsedUrl =
        rawUrl.toHttpUrlOrNull()
            ?: throw TransportException("E_INVALID_URL", "Invalid URL")

    if (parsedUrl.scheme == "http") {
      val isLoopback = parsedUrl.host == "127.0.0.1" || parsedUrl.host == "localhost"
      if (!allowCleartextLoopback || !isLoopback) {
        throw TransportException(
            "E_CLEARTEXT_NOT_ALLOWED",
            "Cleartext HTTP is not allowed",
        )
      }
    }

    val requestBuilder = Request.Builder().url(parsedUrl)

    for ((key, value) in headers) {
      try {
        requestBuilder.header(key, value)
      } catch (_: IllegalArgumentException) {
        // Never echo header names or values (e.g. Authorization Bearer tokens).
        throw TransportException("E_INVALID_REQUEST", "Invalid request header")
      }
    }

    val requestBody: RequestBody? =
        if (normalizedMethod == "POST") {
          val payload = body ?: ""
          val payloadBytes = payload.toByteArray(StandardCharsets.UTF_8)
          if (payloadBytes.size > MAX_REQUEST_BODY_BYTES) {
            throw TransportException(
                "E_PAYLOAD_TOO_LARGE",
                "Request body exceeds 128 KiB limit",
            )
          }
          validatePostContractLimits(parsedUrl.encodedPath, payload)
          OneShotJsonRequestBody(payloadBytes)
        } else {
          null
        }

    return try {
      requestBuilder.method(normalizedMethod, requestBody).build()
    } catch (_: IllegalArgumentException) {
      throw TransportException("E_INVALID_REQUEST", "Invalid HTTP request")
    }
  }

  fun executeAsync(
      method: String,
      rawUrl: String,
      headers: Map<String, String>,
      body: String?,
      timeoutMs: Long,
      onSuccess: (HttpTransportResult) -> Unit,
      onError: (String) -> Unit,
  ) {
    val request =
        try {
          buildRequest(method, rawUrl, headers, body)
        } catch (e: TransportException) {
          onError(e.errorCode)
          return
        }

    val boundedTimeoutMs = timeoutMs.coerceIn(1000L, 60000L)
    val callClient =
        baseClient
            .newBuilder()
            .connectTimeout(boundedTimeoutMs, TimeUnit.MILLISECONDS)
            .readTimeout(boundedTimeoutMs, TimeUnit.MILLISECONDS)
            .writeTimeout(boundedTimeoutMs, TimeUnit.MILLISECONDS)
            .callTimeout(boundedTimeoutMs, TimeUnit.MILLISECONDS)
            .build()

    enqueueWithRetry(callClient, request, attempt = 0, onSuccess = onSuccess, onError = onError)
  }

  private fun enqueueWithRetry(
      callClient: OkHttpClient,
      request: Request,
      attempt: Int,
      onSuccess: (HttpTransportResult) -> Unit,
      onError: (String) -> Unit,
  ) {
    callClient
        .newCall(request)
        .enqueue(
            object : Callback {
              override fun onFailure(call: Call, e: IOException) {
                val code = classifyConnectOrRequestFailure(e)
                if (shouldRetryStaleGet(request.method, attempt, code)) {
                  onDiagnostic?.invoke(
                      "retryStaleGet method=${request.method} attempt=${attempt + 1} type=${e.javaClass.simpleName}")
                  callClient.connectionPool.evictAll()
                  enqueueWithRetry(callClient, request, attempt + 1, onSuccess, onError)
                  return
                }
                onDiagnostic?.invoke(
                    "ioFailure method=${request.method} type=${e.javaClass.simpleName} code=$code")
                onError(code)
              }

              override fun onResponse(call: Call, response: Response) {
                response.use { res ->
                  try {
                    onSuccess(extractResult(res))
                  } catch (e: TransportException) {
                    onError(e.errorCode)
                  }
                }
              }
            })
  }

  fun executeSync(
      method: String,
      rawUrl: String,
      headers: Map<String, String>,
      body: String?,
      timeoutMs: Long = DEFAULT_TIMEOUT_MS,
  ): HttpTransportResult {
    val request = buildRequest(method, rawUrl, headers, body)
    val boundedTimeoutMs = timeoutMs.coerceIn(1000L, 60000L)
    val callClient =
        baseClient
            .newBuilder()
            .connectTimeout(boundedTimeoutMs, TimeUnit.MILLISECONDS)
            .readTimeout(boundedTimeoutMs, TimeUnit.MILLISECONDS)
            .writeTimeout(boundedTimeoutMs, TimeUnit.MILLISECONDS)
            .callTimeout(boundedTimeoutMs, TimeUnit.MILLISECONDS)
            .build()

    for (attempt in 0..1) {
      try {
        return callClient.newCall(request).execute().use { res -> extractResult(res) }
      } catch (e: TransportException) {
        throw e
      } catch (e: IOException) {
        val code = classifyConnectOrRequestFailure(e)
        if (shouldRetryStaleGet(request.method, attempt, code)) {
          onDiagnostic?.invoke(
              "retryStaleGet method=${request.method} attempt=${attempt + 1} type=${e.javaClass.simpleName}")
          callClient.connectionPool.evictAll()
          continue
        }
        onDiagnostic?.invoke(
            "ioFailure method=${request.method} type=${e.javaClass.simpleName} code=$code")
        throw TransportException(code, code)
      }
    }
    throw TransportException("E_NETWORK_ERROR", "E_NETWORK_ERROR")
  }

  internal fun extractResult(
      res: Response,
      forceReadErrorBody: Boolean = false,
  ): HttpTransportResult {
    val status = res.code
    val retryAfter = res.header("Retry-After")

    // Skip unneeded error bodies on non-2xx responses while preserving status and Retry-After.
    if (status !in 200..299 && !forceReadErrorBody) {
      return HttpTransportResult(status = status, retryAfter = retryAfter, body = "")
    }

    val responseBody = res.body ?: return HttpTransportResult(status, retryAfter, "")

    return try {
      val bodyString =
          readBoundedUtf8(responseBody.byteStream())
              ?: if (status in 200..299) {
                throw TransportException("E_RESPONSE_TOO_LARGE", "Response body too large")
              } else {
                ""
              }
      HttpTransportResult(status = status, retryAfter = retryAfter, body = bodyString)
    } catch (e: TransportException) {
      if (status !in 200..299) {
        HttpTransportResult(status = status, retryAfter = retryAfter, body = "")
      } else {
        throw e
      }
    } catch (e: IOException) {
      if (status !in 200..299) {
        // Always return status and Retry-After even if reading an error body fails.
        HttpTransportResult(status = status, retryAfter = retryAfter, body = "")
      } else if (isTimeoutIoException(e)) {
        onDiagnostic?.invoke("bodyReadTimeout status=$status type=${e.javaClass.simpleName}")
        throw TransportException("E_BODY_READ_TIMEOUT", "Timed out reading response body")
      } else {
        onDiagnostic?.invoke("bodyReadError status=$status type=${e.javaClass.simpleName}")
        throw TransportException("E_BODY_READ_ERROR", "Failed reading response body")
      }
    }
  }

  private fun validatePostContractLimits(encodedPath: String, payload: String) {
    val isMessageEndpoint = encodedPath.endsWith("/message")
    val trimmedPayload = payload.trim()
    if (trimmedPayload.isEmpty()) {
      if (isMessageEndpoint) {
        throw TransportException("E_INVALID_REQUEST", "Message request body is required")
      }
      return
    }

    val fields = extractTopLevelJsonValues(trimmedPayload)
    if (fields == null) {
      if (isMessageEndpoint) {
        throw TransportException("E_INVALID_REQUEST", "Message body must be a JSON object")
      }
      return
    }

    val hasMessageField = fields.containsKey("message") || fields.containsKey("prompt")
    val hasRequestIdField = fields.containsKey("clientRequestId")

    if (isMessageEndpoint || hasMessageField) {
      val messageValue =
          when {
            fields.containsKey("message") -> fields["message"]
            fields.containsKey("prompt") -> fields["prompt"]
            else -> null
          }
      val trimmedMessage = messageValue?.trim() ?: ""
      if (trimmedMessage.isEmpty() || trimmedMessage.length > MAX_MESSAGE_CHARS) {
        throw TransportException(
            "E_INVALID_REQUEST",
            "Message must be a non-empty string up to 32,000 characters",
        )
      }
    }

    if (isMessageEndpoint || hasRequestIdField) {
      val requestIdValue = fields["clientRequestId"]?.trim() ?: ""
      if (requestIdValue.isEmpty() || requestIdValue.length > MAX_CLIENT_REQUEST_ID_CHARS) {
        throw TransportException(
            "E_INVALID_REQUEST",
            "clientRequestId must be a non-empty string up to 128 characters",
        )
      }
    }
  }

  private fun readBoundedUtf8(stream: InputStream): String? {
    stream.use { input ->
      val out = ByteArrayOutputStream()
      val buf = ByteArray(8192)
      var total = 0L
      while (true) {
        val read = input.read(buf)
        if (read == -1) break
        total += read
        if (total > MAX_RESPONSE_BYTES) {
          return null
        }
        out.write(buf, 0, read)
      }
      return String(out.toByteArray(), StandardCharsets.UTF_8)
    }
  }

  companion object {
    const val DEFAULT_TIMEOUT_MS = 15000L
    const val MAX_REQUEST_BODY_BYTES = 128 * 1024
    const val MAX_MESSAGE_CHARS = 32_000
    const val MAX_CLIENT_REQUEST_ID_CHARS = 128
    const val MAX_RESPONSE_BYTES = 2L * 1024L * 1024L

    fun shouldRetryStaleGet(method: String, attempt: Int, errorCode: String): Boolean =
        method.equals("GET", ignoreCase = true) && attempt == 0 && errorCode == "E_NETWORK_ERROR"

    fun defaultOkHttpClient(): OkHttpClient =
        OkHttpClient.Builder()
            .connectionPool(ConnectionPool(4, 15, TimeUnit.SECONDS))
            .followRedirects(false)
            .followSslRedirects(false)
            .retryOnConnectionFailure(false)
            .build()

    fun isTimeoutIoException(e: IOException): Boolean {
      var cur: Throwable? = e
      var depth = 0
      while (cur != null && depth < 16) {
        if (cur is SocketTimeoutException || cur is InterruptedIOException) {
          return true
        }
        cur = cur.cause
        depth++
      }
      return false
    }

    fun classifyConnectOrRequestFailure(e: IOException): String {
      var cur: Throwable? = e
      var depth = 0
      while (cur != null && depth < 16) {
        if (cur is SSLException || cur is CertificateException) {
          return "E_TLS_ERROR"
        }
        cur = cur.cause
        depth++
      }
      if (isTimeoutIoException(e)) {
        return "E_TIMEOUT"
      }
      return "E_NETWORK_ERROR"
    }

    /**
     * Minimal pure-Kotlin parser extracting top-level string field values from a
     * JSON object without relying on Android's stubbed org.json in JVM tests.
     * Non-string field values map to null; invalid top-level syntax returns null.
     */
    internal fun extractTopLevelJsonValues(json: String): Map<String, String?>? {
      var idx = skipWhitespace(json, 0)
      if (idx >= json.length || json[idx] != '{') return null
      idx = skipWhitespace(json, idx + 1)
      val result = LinkedHashMap<String, String?>()
      if (idx < json.length && json[idx] == '}') {
        return result
      }

      while (idx < json.length) {
        idx = skipWhitespace(json, idx)
        if (idx >= json.length || json[idx] != '"') return null
        val keyRes = readJsonString(json, idx) ?: return null
        val key = keyRes.first
        idx = skipWhitespace(json, keyRes.second)
        if (idx >= json.length || json[idx] != ':') return null
        idx = skipWhitespace(json, idx + 1)
        if (idx >= json.length) return null

        if (json[idx] == '"') {
          val valRes = readJsonString(json, idx) ?: return null
          result[key] = valRes.first
          idx = valRes.second
        } else {
          val nextIdx = skipJsonValue(json, idx) ?: return null
          result[key] = null
          idx = nextIdx
        }

        idx = skipWhitespace(json, idx)
        if (idx >= json.length) return null
        when (json[idx]) {
          ',' -> idx++
          '}' -> return result
          else -> return null
        }
      }
      return null
    }

    private fun skipWhitespace(s: String, start: Int): Int {
      var i = start
      while (i < s.length && s[i].isWhitespace()) i++
      return i
    }

    private fun readJsonString(s: String, startQuote: Int): Pair<String, Int>? {
      val sb = StringBuilder()
      var i = startQuote + 1
      while (i < s.length) {
        val ch = s[i]
        if (ch == '"') {
          return sb.toString() to (i + 1)
        }
        if (ch == '\\') {
          i++
          if (i >= s.length) return null
          when (val esc = s[i]) {
            '"', '\\', '/' -> sb.append(esc)
            'b' -> sb.append('\b')
            'f' -> sb.append('\u000C')
            'n' -> sb.append('\n')
            'r' -> sb.append('\r')
            't' -> sb.append('\t')
            'u' -> {
              if (i + 4 >= s.length) return null
              val hex = s.substring(i + 1, i + 5)
              val code = hex.toIntOrNull(16) ?: return null
              sb.append(code.toChar())
              i += 4
            }
            else -> return null
          }
        } else {
          sb.append(ch)
        }
        i++
      }
      return null
    }

    private fun skipJsonValue(s: String, start: Int): Int? {
      if (start >= s.length) return null
      return when (s[start]) {
        '{', '[' -> {
          var depth = 0
          var i = start
          while (i < s.length) {
            when (s[i]) {
              '"' -> {
                val str = readJsonString(s, i) ?: return null
                i = str.second
                continue
              }
              '{', '[' -> depth++
              '}', ']' -> {
                depth--
                if (depth == 0) return i + 1
              }
            }
            i++
          }
          null
        }
        else -> {
          var i = start
          while (i < s.length && s[i] != ',' && s[i] != '}' && !s[i].isWhitespace()) {
            i++
          }
          if (i == start) null else i
        }
      }
    }
  }
}
