package com.growthpush.spawneamobile.network

import java.io.IOException
import java.io.InputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.SocketTimeoutException
import java.nio.charset.StandardCharsets
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okio.Buffer
import okio.BufferedSource
import okio.buffer
import okio.source
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class SpawneaHttpTransportTest {

  private fun startLoopbackServer(
      expectedConnections: Int = 1,
      handler: (connectionIndex: Int, socket: java.net.Socket) -> Unit,
  ): Pair<ServerSocket, CountDownLatch> {
    val server = ServerSocket(0, 10, InetAddress.getByName("127.0.0.1"))
    val done = CountDownLatch(expectedConnections)
    val count = AtomicInteger(0)
    val thread =
        Thread {
          while (!server.isClosed) {
            try {
              val sock = server.accept()
              val idx = count.incrementAndGet()
              Thread {
                    try {
                      handler(idx, sock)
                    } catch (_: Exception) {
                      // Ignore test socket close races.
                    } finally {
                      try {
                        sock.close()
                      } catch (_: Exception) {}
                      done.countDown()
                    }
                  }
                  .start()
            } catch (_: IOException) {
              break
            }
          }
        }
    thread.isDaemon = true
    thread.start()
    return server to done
  }

  private fun readSingleHttpRequest(sock: java.net.Socket) {
    sock.soTimeout = 3000
    val input = sock.getInputStream()
    val headerBuf = StringBuilder()
    val window = ByteArray(4)
    var b: Int
    while (input.read().also { b = it } != -1) {
      headerBuf.append(b.toChar())
      window[0] = window[1]
      window[1] = window[2]
      window[2] = window[3]
      window[3] = b.toByte()
      if (window[0] == '\r'.code.toByte() &&
          window[1] == '\n'.code.toByte() &&
          window[2] == '\r'.code.toByte() &&
          window[3] == '\n'.code.toByte()) {
        break
      }
    }
    val headers = headerBuf.toString()
    val clMatch =
        Regex("(?im)^Content-Length:\\s*(\\d+)\\s*$").find(headers)?.groupValues?.get(1)?.toIntOrNull()
            ?: 0
    if (clMatch > 0) {
      var remaining = clMatch
      val discard = ByteArray(1024)
      while (remaining > 0) {
        val read = input.read(discard, 0, minOf(remaining, discard.size))
        if (read == -1) break
        remaining -= read
      }
    }
  }

  @Test
  fun oneShotRequestBodyIsOneShotAndRejectsSecondWrite() {
    val body = OneShotJsonRequestBody("{\"hello\":\"world\"}".toByteArray(StandardCharsets.UTF_8))
    assertTrue(body.isOneShot())

    val buf = Buffer()
    body.writeTo(buf)
    assertEquals("{\"hello\":\"world\"}", buf.readUtf8())

    try {
      body.writeTo(Buffer())
      fail("Expected second writeTo to throw IOException")
    } catch (_: IOException) {
      // Expected
    }
  }

  @Test
  fun controlNonOneShotPostWouldRetryOn503WithRetryAfterZero() {
    val hits = AtomicInteger(0)
    val (server, done) =
        startLoopbackServer(expectedConnections = 2) { idx, sock ->
          readSingleHttpRequest(sock)
          hits.incrementAndGet()
          val out = sock.getOutputStream()
          if (idx == 1) {
            out.write(
                ("HTTP/1.1 503 Service Unavailable\r\nRetry-After: 0\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
                    .toByteArray(StandardCharsets.US_ASCII))
          } else {
            out.write(
                ("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}")
                    .toByteArray(StandardCharsets.US_ASCII))
          }
          out.flush()
        }

    server.use {
      val controlClient =
          OkHttpClient.Builder()
              .followRedirects(false)
              .followSslRedirects(false)
              .retryOnConnectionFailure(false)
              .build()
      val nonOneShotReq =
          Request.Builder()
              .url("http://127.0.0.1:${server.localPort}/api/v1/sessions/s1/message")
              .post("{}".toRequestBody("application/json".toMediaType()))
              .build()
      controlClient.newCall(nonOneShotReq).execute().use { res ->
        assertEquals(200, res.code)
      }
      assertTrue(done.await(3, TimeUnit.SECONDS))
      assertEquals(2, hits.get())
    }
  }

  @Test
  fun postReceivesExactlyOneServerRequestOn503WithRetryAfterZero() {
    val hits = AtomicInteger(0)
    val (server, done) =
        startLoopbackServer(expectedConnections = 1) { _, sock ->
          readSingleHttpRequest(sock)
          hits.incrementAndGet()
          val out = sock.getOutputStream()
          out.write(
              ("HTTP/1.1 503 Service Unavailable\r\nRetry-After: 0\r\nContent-Length: 15\r\n\r\nservice_restart")
                  .toByteArray(StandardCharsets.US_ASCII))
          out.flush()
        }

    server.use {
      val transport = SpawneaHttpTransport(allowCleartextLoopback = true)
      val res =
          transport.executeSync(
              method = "POST",
              rawUrl = "http://127.0.0.1:${server.localPort}/api/v1/sessions/s1/message",
              headers = mapOf("Authorization" to "Bearer test-key"),
              body = """{"message":"hi","clientRequestId":"req-503"}""",
              timeoutMs = 3000L,
          )
      assertTrue(done.await(3, TimeUnit.SECONDS))
      // Give OkHttp a brief moment to prove no second request is initiated.
      Thread.sleep(150)
      assertEquals(1, hits.get())
      assertEquals(503, res.status)
      assertEquals("0", res.retryAfter)
    }
  }

  @Test
  fun postReceivesExactlyOneServerRequestOn421AndBodyIsOneShot() {
    val hits = AtomicInteger(0)
    val (server, done) =
        startLoopbackServer(expectedConnections = 1) { _, sock ->
          readSingleHttpRequest(sock)
          hits.incrementAndGet()
          val out = sock.getOutputStream()
          out.write(
              ("HTTP/1.1 421 Misdirected Request\r\nContent-Length: 0\r\n\r\n")
                  .toByteArray(StandardCharsets.US_ASCII))
          out.flush()
        }

    server.use {
      val transport = SpawneaHttpTransport(allowCleartextLoopback = true)
      val built =
          transport.buildRequest(
              method = "POST",
              rawUrl = "http://127.0.0.1:${server.localPort}/api/v1/sessions/s1/message",
              headers = mapOf("Authorization" to "Bearer test-key"),
              body = """{"message":"hi","clientRequestId":"req-421"}""",
          )
      assertTrue(built.body?.isOneShot() == true)

      val res =
          transport.executeSync(
              method = "POST",
              rawUrl = "http://127.0.0.1:${server.localPort}/api/v1/sessions/s1/message",
              headers = mapOf("Authorization" to "Bearer test-key"),
              body = """{"message":"hi","clientRequestId":"req-421"}""",
              timeoutMs = 3000L,
          )
      assertTrue(done.await(3, TimeUnit.SECONDS))
      Thread.sleep(150)
      assertEquals(1, hits.get())
      assertEquals(421, res.status)
    }
  }

  @Test
  fun postReceivesExactlyOneServerRequestOnDroppedConnection() {
    val hits = AtomicInteger(0)
    val (server, done) =
        startLoopbackServer(expectedConnections = 1) { _, sock ->
          readSingleHttpRequest(sock)
          hits.incrementAndGet()
          // Drop connection without sending any HTTP response.
        }

    server.use {
      val transport = SpawneaHttpTransport(allowCleartextLoopback = true)
      try {
        transport.executeSync(
            method = "POST",
            rawUrl = "http://127.0.0.1:${server.localPort}/api/v1/sessions/s1/message",
            headers = mapOf("Authorization" to "Bearer test-key"),
            body = """{"message":"hi","clientRequestId":"req-drop"}""",
            timeoutMs = 3000L,
        )
        fail("Expected E_NETWORK_ERROR on dropped connection")
      } catch (e: TransportException) {
        assertEquals("E_NETWORK_ERROR", e.errorCode)
      }
      assertTrue(done.await(3, TimeUnit.SECONDS))
      Thread.sleep(150)
      assertEquals(1, hits.get())
    }
  }

  @Test
  fun invalidHeaderWithNewlineIsRejectedWithoutLeakingSecretOrDispatching() {
    val hits = AtomicInteger(0)
    val (server, _) =
        startLoopbackServer(expectedConnections = 0) { _, _ ->
          hits.incrementAndGet()
        }

    server.use {
      val transport = SpawneaHttpTransport(allowCleartextLoopback = true)
      val secretToken = "SUPER_SECRET_NEWLINE_TOKEN"
      try {
        transport.executeSync(
            method = "GET",
            rawUrl = "http://127.0.0.1:${server.localPort}/api/v1/sessions",
            headers = mapOf("Authorization" to "Bearer $secretToken\nX-Injected: true"),
            body = null,
            timeoutMs = 2000L,
        )
        fail("Expected E_INVALID_REQUEST")
      } catch (e: TransportException) {
        assertEquals("E_INVALID_REQUEST", e.errorCode)
        assertFalse((e.message ?: "").contains(secretToken))
      }
      assertEquals(0, hits.get())
    }
  }

  @Test
  fun contractLimitsRejectOversizedBodyMessageAndRequestIdBeforeDispatch() {
    val hits = AtomicInteger(0)
    val (server, _) =
        startLoopbackServer(expectedConnections = 0) { _, _ ->
          hits.incrementAndGet()
        }

    server.use {
      val transport = SpawneaHttpTransport(allowCleartextLoopback = true)
      val url = "http://127.0.0.1:${server.localPort}/api/v1/sessions/s1/message"
      val headers = mapOf("Authorization" to "Bearer valid-key")

      // > 128 KiB body
      val hugeBody = "x".repeat(128 * 1024 + 1)
      try {
        transport.executeSync("POST", url, headers, hugeBody, 2000L)
        fail("Expected E_PAYLOAD_TOO_LARGE")
      } catch (e: TransportException) {
        assertEquals("E_PAYLOAD_TOO_LARGE", e.errorCode)
      }

      // > 32,000 char message
      val tooLongMsg = "a".repeat(32_001)
      try {
        transport.executeSync(
            "POST",
            url,
            headers,
            """{"message":"$tooLongMsg","clientRequestId":"req-1"}""",
            2000L,
        )
        fail("Expected E_INVALID_REQUEST for >32,000 char message")
      } catch (e: TransportException) {
        assertEquals("E_INVALID_REQUEST", e.errorCode)
      }

      // > 128 char clientRequestId
      val tooLongId = "r".repeat(129)
      try {
        transport.executeSync(
            "POST",
            url,
            headers,
            """{"message":"hello","clientRequestId":"$tooLongId"}""",
            2000L,
        )
        fail("Expected E_INVALID_REQUEST for >128 char clientRequestId")
      } catch (e: TransportException) {
        assertEquals("E_INVALID_REQUEST", e.errorCode)
      }

      // Empty message
      try {
        transport.executeSync(
            "POST",
            url,
            headers,
            """{"message":"   ","clientRequestId":"req-2"}""",
            2000L,
        )
        fail("Expected E_INVALID_REQUEST for empty message")
      } catch (e: TransportException) {
        assertEquals("E_INVALID_REQUEST", e.errorCode)
      }

      assertEquals(0, hits.get())
    }
  }

  @Test
  fun skipsUnneededErrorBodyAndReturnsStatusAndRetryAfterEvenIfErrorStreamFails() {
    val transport = SpawneaHttpTransport(allowCleartextLoopback = true)
    val (server, done) =
        startLoopbackServer(expectedConnections = 1) { _, sock ->
          readSingleHttpRequest(sock)
          val out = sock.getOutputStream()
          out.write(
              ("HTTP/1.1 429 Too Many Requests\r\nRetry-After: 17\r\nContent-Length: 500\r\n\r\ntrunc")
                  .toByteArray(StandardCharsets.US_ASCII))
          out.flush()
        }

    server.use {
      val res =
          transport.executeSync(
              method = "GET",
              rawUrl = "http://127.0.0.1:${server.localPort}/api/v1/sessions",
              headers = mapOf("Authorization" to "Bearer test-key"),
              body = null,
              timeoutMs = 2000L,
          )
      assertTrue(done.await(3, TimeUnit.SECONDS))
      assertEquals(429, res.status)
      assertEquals("17", res.retryAfter)
      assertEquals("", res.body)
    }

    // Even when reading an error body fails with IOException, status and Retry-After are preserved.
    val failingStream =
        object : InputStream() {
          override fun read(): Int = throw IOException("broken error stream")
          override fun read(b: ByteArray, off: Int, len: Int): Int =
              throw IOException("broken error stream")
        }
    val synthetic429 =
        Response.Builder()
            .request(Request.Builder().url("https://example.test/api/v1/sessions").build())
            .protocol(Protocol.HTTP_1_1)
            .code(429)
            .message("Too Many Requests")
            .header("Retry-After", "42")
            .body(
                object : okhttp3.ResponseBody() {
                  override fun contentType() = "text/plain".toMediaType()
                  override fun contentLength() = -1L
                  override fun source(): BufferedSource = failingStream.source().buffer()
                })
            .build()
    val extracted = transport.extractResult(synthetic429, forceReadErrorBody = true)
    assertEquals(429, extracted.status)
    assertEquals("42", extracted.retryAfter)
    assertEquals("", extracted.body)
  }

  @Test
  fun bodyReadTimeoutIsClassifiedSeparatelyFromGeneralNetworkError() {
    val (server, done) =
        startLoopbackServer(expectedConnections = 1) { _, sock ->
          readSingleHttpRequest(sock)
          val out = sock.getOutputStream()
          // Send 200 headers promising 100 bytes, write 5 bytes, then stall past readTimeout.
          out.write(
              ("HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nhello")
                  .toByteArray(StandardCharsets.US_ASCII))
          out.flush()
          Thread.sleep(2000)
        }

    server.use {
      val transport = SpawneaHttpTransport(allowCleartextLoopback = true)
      try {
        transport.executeSync(
            method = "GET",
            rawUrl = "http://127.0.0.1:${server.localPort}/api/v1/sessions",
            headers = mapOf("Authorization" to "Bearer test-key"),
            body = null,
            timeoutMs = 1000L,
        )
        fail("Expected E_BODY_READ_TIMEOUT")
      } catch (e: TransportException) {
        assertEquals("E_BODY_READ_TIMEOUT", e.errorCode)
      }
      assertTrue(done.await(4, TimeUnit.SECONDS))
    }

    assertEquals(
        "E_BODY_READ_TIMEOUT",
        if (SpawneaHttpTransport.isTimeoutIoException(SocketTimeoutException("read timed out"))) {
          "E_BODY_READ_TIMEOUT"
        } else {
          "unexpected"
        },
    )
  }

  @Test
  fun httpsAgainstPlainHttpServerClassifiesAsTlsError() {
    val (server, done) =
        startLoopbackServer(expectedConnections = 1) { _, sock ->
          val out = sock.getOutputStream()
          out.write("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n".toByteArray())
          out.flush()
        }

    server.use {
      val transport = SpawneaHttpTransport(allowCleartextLoopback = false)
      try {
        transport.executeSync(
            method = "GET",
            rawUrl = "https://127.0.0.1:${server.localPort}/api/v1/sessions",
            headers = mapOf("Authorization" to "Bearer test-key"),
            body = null,
            timeoutMs = 2000L,
        )
        fail("Expected E_TLS_ERROR")
      } catch (e: TransportException) {
        assertEquals("E_TLS_ERROR", e.errorCode)
      }
      assertTrue(done.await(3, TimeUnit.SECONDS))
    }
  }

  @Test
  fun getRetriesOnceWhenServerClosesIdleKeepAliveConnectionSyncAndAsync() {
    val allowCloseIdle = CountDownLatch(1)
    val idleClosed = CountDownLatch(1)
    val connections = AtomicInteger(0)
    val (server, done) =
        startLoopbackServer(expectedConnections = 2) { idx, sock ->
          connections.incrementAndGet()
          if (idx == 1) {
            readSingleHttpRequest(sock)
            val out = sock.getOutputStream()
            out.write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}".toByteArray())
            out.flush()
            allowCloseIdle.await(3, TimeUnit.SECONDS)
            sock.close()
            idleClosed.countDown()
          } else {
            readSingleHttpRequest(sock)
            val out = sock.getOutputStream()
            out.write("HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\n{\"ok\":123}".toByteArray())
            out.flush()
          }
        }

    server.use {
      val transport = SpawneaHttpTransport(allowCleartextLoopback = true)
      val first =
          transport.executeSync(
              method = "GET",
              rawUrl = "http://127.0.0.1:${server.localPort}/api/v1/sessions",
              headers = mapOf("Authorization" to "Bearer test-key"),
              body = null,
              timeoutMs = 2000L,
          )
      assertEquals(200, first.status)
      assertEquals("{}", first.body)

      allowCloseIdle.countDown()
      assertTrue(idleClosed.await(3, TimeUnit.SECONDS))
      Thread.sleep(30)

      val second =
          transport.executeSync(
              method = "GET",
              rawUrl = "http://127.0.0.1:${server.localPort}/api/v1/sessions",
              headers = mapOf("Authorization" to "Bearer test-key"),
              body = null,
              timeoutMs = 2000L,
          )
      assertEquals(200, second.status)
      assertEquals("{\"ok\":123}", second.body)
      assertTrue(done.await(3, TimeUnit.SECONDS))
      assertEquals(2, connections.get())
    }

    // Async GET retry verification
    val allowCloseAsync = CountDownLatch(1)
    val asyncClosed = CountDownLatch(1)
    val asyncConnections = AtomicInteger(0)
    val (asyncServer, asyncDone) =
        startLoopbackServer(expectedConnections = 2) { idx, sock ->
          asyncConnections.incrementAndGet()
          if (idx == 1) {
            readSingleHttpRequest(sock)
            val out = sock.getOutputStream()
            out.write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}".toByteArray())
            out.flush()
            allowCloseAsync.await(3, TimeUnit.SECONDS)
            sock.close()
            asyncClosed.countDown()
          } else {
            readSingleHttpRequest(sock)
            val out = sock.getOutputStream()
            out.write("HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\n{\"ok\":true}".toByteArray())
            out.flush()
          }
        }

    asyncServer.use {
      val transport = SpawneaHttpTransport(allowCleartextLoopback = true)
      val prime =
          transport.executeSync(
              method = "GET",
              rawUrl = "http://127.0.0.1:${asyncServer.localPort}/api/v1/sessions",
              headers = mapOf("Authorization" to "Bearer test-key"),
              body = null,
              timeoutMs = 2000L,
          )
      assertEquals(200, prime.status)

      allowCloseAsync.countDown()
      assertTrue(asyncClosed.await(3, TimeUnit.SECONDS))
      Thread.sleep(30)

      val latch = CountDownLatch(1)
      var asyncResult: HttpTransportResult? = null
      var asyncErr: String? = null
      transport.executeAsync(
          method = "GET",
          rawUrl = "http://127.0.0.1:${asyncServer.localPort}/api/v1/sessions",
          headers = mapOf("Authorization" to "Bearer test-key"),
          body = null,
          timeoutMs = 2000L,
          onSuccess = {
            asyncResult = it
            latch.countDown()
          },
          onError = {
            asyncErr = it
            latch.countDown()
          },
      )
      assertTrue(latch.await(3, TimeUnit.SECONDS))
      assertEquals(null, asyncErr)
      assertEquals(200, asyncResult?.status)
      assertEquals("{\"ok\":true}", asyncResult?.body)
      assertTrue(asyncDone.await(3, TimeUnit.SECONDS))
      assertEquals(2, asyncConnections.get())
    }
  }

  @Test
  fun postDoesNotRetryWhenServerClosesIdleKeepAliveConnection() {
    val allowCloseIdle = CountDownLatch(1)
    val idleClosed = CountDownLatch(1)
    val connections = AtomicInteger(0)
    val (server, done) =
        startLoopbackServer(expectedConnections = 1) { _, sock ->
          connections.incrementAndGet()
          readSingleHttpRequest(sock)
          val out = sock.getOutputStream()
          out.write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}".toByteArray())
          out.flush()
          allowCloseIdle.await(3, TimeUnit.SECONDS)
          sock.close()
          idleClosed.countDown()
        }

    server.use {
      val transport = SpawneaHttpTransport(allowCleartextLoopback = true)
      val first =
          transport.executeSync(
              method = "GET",
              rawUrl = "http://127.0.0.1:${server.localPort}/api/v1/sessions",
              headers = mapOf("Authorization" to "Bearer test-key"),
              body = null,
              timeoutMs = 2000L,
          )
      assertEquals(200, first.status)

      allowCloseIdle.countDown()
      assertTrue(idleClosed.await(3, TimeUnit.SECONDS))
      Thread.sleep(30)

      try {
        transport.executeSync(
            method = "POST",
            rawUrl = "http://127.0.0.1:${server.localPort}/api/v1/sessions/s1/messages",
            headers = mapOf("Authorization" to "Bearer test-key"),
            body = """{"message":"hi"}""",
            timeoutMs = 2000L,
        )
        fail("Expected E_NETWORK_ERROR on closed idle connection for POST")
      } catch (e: TransportException) {
        assertEquals("E_NETWORK_ERROR", e.errorCode)
      }
      assertTrue(done.await(3, TimeUnit.SECONDS))
      assertEquals(1, connections.get())
    }
  }

  @Test
  fun returnsJsonErrorBodyForNon2xxResponsesWithoutLoggingBodiesOrHeaders() {
    val diagnostics = mutableListOf<String>()
    val secretHeaderValue = "Bearer top-secret-key-999"
    val json409Body =
        """{"apiVersion":"v1","error":{"code":"conflict","message":"Client request ID 'req-1' was already used with a different prompt"}}"""
    val json422Body =
        """{"apiVersion":"v1","error":{"code":"needs_human","message":"Session requires human confirmation"}}"""
    val hits = AtomicInteger(0)

    val (server, done) =
        startLoopbackServer(expectedConnections = 2) { idx, sock ->
          readSingleHttpRequest(sock)
          hits.incrementAndGet()
          val out = sock.getOutputStream()
          if (idx == 1) {
            val bytes = json409Body.toByteArray(StandardCharsets.UTF_8)
            out.write(
                ("HTTP/1.1 409 Conflict\r\nContent-Type: application/json; charset=utf-8\r\nConnection: close\r\nContent-Length: ${bytes.size}\r\n\r\n")
                    .toByteArray(StandardCharsets.US_ASCII))
            out.write(bytes)
          } else {
            val bytes = json422Body.toByteArray(StandardCharsets.UTF_8)
            out.write(
                ("HTTP/1.1 422 Unprocessable Entity\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: ${bytes.size}\r\n\r\n")
                    .toByteArray(StandardCharsets.US_ASCII))
            out.write(bytes)
          }
          out.flush()
        }

    server.use {
      val transport =
          SpawneaHttpTransport(
              allowCleartextLoopback = true,
              onDiagnostic = { diagnostics.add(it) },
          )

      val res409 =
          transport.executeSync(
              method = "POST",
              rawUrl = "http://127.0.0.1:${server.localPort}/api/v1/sessions/s1/message",
              headers = mapOf("Authorization" to secretHeaderValue),
              body = """{"message":"hi","clientRequestId":"req-1"}""",
              timeoutMs = 3000L,
          )
      assertEquals(409, res409.status)
      assertEquals(json409Body, res409.body)

      val latch = CountDownLatch(1)
      var asyncRes: HttpTransportResult? = null
      var asyncErr: String? = null
      transport.executeAsync(
          method = "POST",
          rawUrl = "http://127.0.0.1:${server.localPort}/api/v1/sessions/s1/message",
          headers = mapOf("Authorization" to secretHeaderValue),
          body = """{"message":"hi2","clientRequestId":"req-2"}""",
          timeoutMs = 3000L,
          onSuccess = {
            asyncRes = it
            latch.countDown()
          },
          onError = {
            asyncErr = it
            latch.countDown()
          },
      )
      assertTrue(latch.await(3, TimeUnit.SECONDS))
      assertEquals(null, asyncErr)
      assertEquals(422, asyncRes?.status)
      assertEquals(json422Body, asyncRes?.body)

      assertTrue(done.await(3, TimeUnit.SECONDS))
      assertEquals(2, hits.get())
      assertTrue(diagnostics.none { it.contains("already used") || it.contains(secretHeaderValue) })
    }
  }

  @Test
  fun boundsOverlongJsonErrorBodyTo4KiBWithUtf8BoundarySafetyAndSkipsHtmlErrors() {
    val transport = SpawneaHttpTransport(allowCleartextLoopback = true)
    // Prefix 4094 ASCII bytes followed by a 4-byte emoji splitting directly across the 4096-byte limit.
    val prefix = """{"error":{"code":"conflict","message":"""" + "a".repeat(4055) + "\uD83D\uDE80"
    val suffix = """tail"}}"""
    val fullJsonBytes = (prefix + suffix).toByteArray(StandardCharsets.UTF_8)
    assertTrue(fullJsonBytes.size > SpawneaHttpTransport.MAX_ERROR_RESPONSE_BYTES)

    val (server, done) =
        startLoopbackServer(expectedConnections = 2) { idx, sock ->
          readSingleHttpRequest(sock)
          val out = sock.getOutputStream()
          if (idx == 1) {
            out.write(
                ("HTTP/1.1 409 Conflict\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: ${fullJsonBytes.size}\r\n\r\n")
                    .toByteArray(StandardCharsets.US_ASCII))
            out.write(fullJsonBytes)
          } else {
            val html = "<html><body>Bad Gateway</body></html>"
            out.write(
                ("HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/html\r\nConnection: close\r\nContent-Length: ${html.length}\r\n\r\n$html")
                    .toByteArray(StandardCharsets.US_ASCII))
          }
          out.flush()
        }

    server.use {
      val res409 =
          transport.executeSync(
              method = "POST",
              rawUrl = "http://127.0.0.1:${server.localPort}/api/v1/sessions/s1/message",
              headers = mapOf("Authorization" to "Bearer test-key"),
              body = """{"message":"hi","clientRequestId":"req-long"}""",
              timeoutMs = 3000L,
          )
      assertEquals(409, res409.status)
      val returnedBytes = res409.body.toByteArray(StandardCharsets.UTF_8)
      assertTrue(returnedBytes.size <= SpawneaHttpTransport.MAX_ERROR_RESPONSE_BYTES.toInt())
      assertFalse(res409.body.contains('\uFFFD'))
      assertTrue(res409.body.contains("\"code\":\"conflict\""))

      val res502 =
          transport.executeSync(
              method = "GET",
              rawUrl = "http://127.0.0.1:${server.localPort}/api/v1/sessions",
              headers = mapOf("Authorization" to "Bearer test-key"),
              body = null,
              timeoutMs = 3000L,
          )
      assertEquals(502, res502.status)
      assertEquals("", res502.body)
      assertTrue(done.await(3, TimeUnit.SECONDS))
    }
  }
}
