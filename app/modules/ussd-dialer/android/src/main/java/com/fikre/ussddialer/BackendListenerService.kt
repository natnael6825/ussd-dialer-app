package com.fikre.ussddialer

import android.app.KeyguardManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.min

internal data class BackendConfig(
  val baseUrl: String,
  val deviceId: String,
  val deviceName: String,
  val deviceToken: String,
  val desiredRunning: Boolean,
  val generation: Long
)

private class BackendAuthenticationException : Exception("Backend authentication expired")
private class BackendWorkerStoppedException : Exception("Backend listener stopped")

internal object BackendController {
  fun validateBaseUrl(value: String): String {
    val clean = value.trim().trimEnd('/')
    val uri = try { URI(clean) } catch (_: Exception) { throw IllegalArgumentException("Enter a valid backend URL") }
    val scheme = uri.scheme?.lowercase()
    val host = uri.host?.lowercase().orEmpty()
    if (uri.userInfo != null || host.isEmpty() || uri.query != null || uri.fragment != null) {
      throw IllegalArgumentException("The backend URL cannot contain credentials, a query, or a fragment")
    }
    val localDevelopment = scheme == "http" && host in setOf("localhost", "127.0.0.1", "10.0.2.2")
    if (scheme != "https" && !localDevelopment) {
      throw IllegalArgumentException("Use HTTPS. HTTP is allowed only for localhost through adb during development")
    }
    if (localDevelopment && !BuildConfig.DEBUG) {
      throw IllegalArgumentException("HTTP localhost is available only in a debug build. Use HTTPS for installed releases")
    }
    return clean
  }

  fun deviceId(context: Context): String {
    val androidId = Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID).orEmpty()
    val digest = MessageDigest.getInstance("SHA-256")
      .digest("${context.packageName}:$androidId".toByteArray(Charsets.UTF_8))
      .joinToString("") { "%02x".format(it) }
    return "android-${digest.take(32)}"
  }

  fun configuration(context: Context): BackendConfig? {
    val stored = UssdAutomationStore.backendConfiguration(context)
    val baseUrl = stored["baseUrl"]?.toString().orEmpty()
    val deviceId = stored["deviceId"]?.toString().orEmpty()
    val name = stored["deviceName"]?.toString().orEmpty()
    val token = stored["deviceToken"]?.toString().orEmpty()
    if (baseUrl.isEmpty() || deviceId.isEmpty() || name.isEmpty() || token.isEmpty()) return null
    return BackendConfig(
      baseUrl,
      deviceId,
      name,
      token,
      stored["desiredRunning"] == true,
      (stored["generation"] as? Number)?.toLong() ?: 0L
    )
  }

  fun status(context: Context): Map<String, Any> {
    val stored = UssdAutomationStore.backendConfiguration(context)
    val configured = stored["baseUrl"]?.toString().orEmpty().isNotEmpty() &&
      stored["deviceToken"]?.toString().orEmpty().isNotEmpty()
    val pendingId = try {
      JSONObject(stored["pendingJob"]?.toString().orEmpty()).optString("id")
    } catch (_: Exception) { "" }
    return mapOf(
      "configured" to configured,
      "running" to BackendListenerService.isRunning(),
      "connected" to (BackendListenerService.isRunning() && stored["connected"] == true),
      "baseUrl" to stored["baseUrl"]?.toString().orEmpty(),
      "deviceId" to stored["deviceId"]?.toString().orEmpty(),
      "deviceName" to stored["deviceName"]?.toString().orEmpty(),
      "state" to stored["state"]?.toString().orEmpty().ifEmpty { if (configured) "configured" else "not_configured" },
      "lastError" to stored["lastError"]?.toString().orEmpty(),
      "lastContactAt" to (stored["lastContactAt"] as? Long ?: 0L),
      "pendingJobId" to pendingId
    )
  }

  fun start(context: Context) {
    if (!BackendListenerService.isFullyStopped()) {
      throw IllegalStateException("The previous backend listener is still stopping. Wait a moment and try again")
    }
    if (configuration(context) == null) throw IllegalStateException("Configure the backend first")
    if (!UssdAutomationStore.setBackendDesiredRunning(context, true, "starting")) {
      throw IllegalStateException("Could not save the listener state securely")
    }
    val intent = Intent(context, BackendListenerService::class.java).setAction(BackendListenerService.ACTION_START)
    try {
      ContextCompat.startForegroundService(context, intent)
    } catch (error: Exception) {
      UssdAutomationStore.setBackendDesiredRunning(context, false, "start_failed")
      throw IllegalStateException("Android could not start the background listener while the app was visible", error)
    }
  }

  fun stop(context: Context) {
    if (!UssdAutomationStore.setBackendDesiredRunning(context, false, "stopping")) {
      throw IllegalStateException("Could not save the listener stop state securely")
    }
    if (!BackendListenerService.stopAndAwait(STOP_TIMEOUT_MS)) {
      throw IllegalStateException("The backend listener did not stop safely. Wait a moment before changing its configuration")
    }
    UssdAutomationStore.updateBackendConnection(context, false, "stopped")
  }

  fun requestCatalogSync(context: Context) {
    if (!BackendListenerService.isRunning()) throw IllegalStateException("Start the backend listener before syncing flows")
    context.startService(Intent(context, BackendListenerService::class.java).setAction(BackendListenerService.ACTION_SYNC))
  }

  fun listQueuedJobs(context: Context): List<Map<String, Any>> {
    val config = configuration(context)
      ?: throw IllegalStateException("Connect this phone to a backend before opening the queue")
    val response = BackendHttp.request(
      config.baseUrl,
      "/api/device/jobs",
      "GET",
      "Device ${config.deviceToken}",
      readTimeoutMs = 15_000
    )
    requireQueueSuccess(response, "load")
    val payload = try {
      JSONObject(response.body)
    } catch (_: Exception) {
      throw IllegalStateException("Backend returned an invalid queue response")
    }
    val jobs = payload.optJSONArray("jobs")
      ?: throw IllegalStateException("Backend returned an invalid queue response")
    if (jobs.length() > MAX_VISIBLE_QUEUE_ITEMS) {
      throw IllegalStateException("Backend returned too many queued requests")
    }
    return (0 until jobs.length()).map { index ->
      parseQueueJob(jobs.optJSONObject(index), expectedStatus = "queued")
    }
  }

  fun cancelQueuedJob(context: Context, jobId: String) {
    val cleanId = jobId.trim()
    if (!QUEUE_JOB_ID.matches(cleanId)) throw IllegalArgumentException("Queued request id is invalid")
    val config = configuration(context)
      ?: throw IllegalStateException("Connect this phone to a backend before changing the queue")
    val response = BackendHttp.request(
      config.baseUrl,
      "/api/device/jobs/$cleanId",
      "DELETE",
      "Device ${config.deviceToken}",
      readTimeoutMs = 15_000
    )
    requireQueueSuccess(response, "delete")
    val payload = try {
      JSONObject(response.body)
    } catch (_: Exception) {
      throw IllegalStateException("Backend returned an invalid delete response")
    }
    parseQueueJob(payload.optJSONObject("job"), expectedStatus = "cancelled")
  }

  private fun parseQueueJob(value: JSONObject?, expectedStatus: String): Map<String, Any> {
    if (value == null) throw IllegalStateException("Backend returned an invalid queued request")
    val id = value.optString("id").trim()
    val flowId = value.optString("flowId").trim()
    val flowName = value.optString("flowName").trim()
    val status = value.optString("status").trim()
    val createdAt = value.optLong("createdAt", -1L)
    val expiresAt = value.optLong("expiresAt", -1L)
    if (
      !QUEUE_JOB_ID.matches(id) ||
      flowId.isEmpty() || flowId.length > 128 || flowId.any(Char::isISOControl) ||
      flowName.isEmpty() || flowName.length > 80 || flowName.any(Char::isISOControl) ||
      status != expectedStatus ||
      createdAt <= 0L || expiresAt < createdAt
    ) {
      throw IllegalStateException("Backend returned an invalid queued request")
    }
    return mapOf(
      "id" to id,
      "flowId" to flowId,
      "flowName" to flowName,
      "status" to status,
      "createdAt" to createdAt,
      "expiresAt" to expiresAt
    )
  }

  private fun requireQueueSuccess(response: BackendHttp.Response, action: String) {
    if (response.status in 200..299) return
    when (response.status) {
      401, 403 -> throw IllegalStateException("Backend authentication expired. Reconnect this phone in Backend settings")
      404 -> throw IllegalStateException("That queued request no longer exists. Refresh the queue")
      409 -> {
        val error = try { JSONObject(response.body).optJSONObject("error") } catch (_: Exception) { null }
        val code = error?.optString("code").orEmpty()
        if (code == "RUN_NOT_CANCELLABLE") {
          val currentStatus = error?.optJSONObject("details")?.optString("currentStatus").orEmpty()
          if (currentStatus == "expired") {
            throw IllegalStateException("That queued request expired before delivery. Refresh the queue")
          }
          throw IllegalStateException("That request has already reached the phone and cannot be deleted safely")
        }
        throw IllegalStateException("The queued request changed before it could be deleted. Refresh the queue")
      }
      else -> throw IllegalStateException("Could not $action the backend queue (HTTP ${response.status})")
    }
  }

  private const val STOP_TIMEOUT_MS = 12_000L
  private const val MAX_VISIBLE_QUEUE_ITEMS = 256
  private val QUEUE_JOB_ID = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
}

internal object BackendHttp {
  data class Response(val status: Int, val body: String)

  fun register(baseUrl: String, enrollmentKey: String, proposedDeviceId: String, name: String): Pair<String, String> {
    val payload = JSONObject().put("deviceId", proposedDeviceId).put("name", name)
    val response = request(baseUrl, "/api/device/register", "POST", "Bearer $enrollmentKey", payload, 15_000)
    if (response.status !in 200..299) throw IllegalStateException("Backend registration failed (HTTP ${response.status})")
    val json = try { JSONObject(response.body) } catch (_: Exception) { throw IllegalStateException("Backend returned an invalid registration response") }
    val id = json.optString("deviceId").trim()
    val token = json.optString("deviceToken").trim()
    if (id.isEmpty() || id.length > 128 || token.isEmpty() || token.length > 2048 || token.any(Char::isISOControl)) {
      throw IllegalStateException("Backend returned invalid device credentials")
    }
    return id to token
  }

  fun request(
    baseUrl: String,
    path: String,
    method: String,
    authorization: String,
    body: JSONObject? = null,
    readTimeoutMs: Int = 35_000,
    onOpened: ((HttpURLConnection) -> Unit)? = null,
    onClosed: ((HttpURLConnection) -> Unit)? = null
  ): Response {
    val connection = URL(baseUrl + path).openConnection() as HttpURLConnection
    return try {
      onOpened?.invoke(connection)
      connection.instanceFollowRedirects = false
      connection.requestMethod = method
      connection.connectTimeout = 12_000
      connection.readTimeout = readTimeoutMs
      connection.useCaches = false
      connection.setRequestProperty("Accept", "application/json")
      connection.setRequestProperty("Authorization", authorization)
      connection.setRequestProperty("User-Agent", "USSD-Flow-Android/1")
      if (body != null) {
        val bytes = body.toString().toByteArray(Charsets.UTF_8)
        connection.doOutput = true
        connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
        connection.setFixedLengthStreamingMode(bytes.size)
        connection.outputStream.use { it.write(bytes) }
      }
      val status = connection.responseCode
      val stream = if (status in 200..399) connection.inputStream else connection.errorStream
      Response(status, readBounded(stream))
    } finally {
      onClosed?.invoke(connection)
      connection.disconnect()
    }
  }

  private fun readBounded(input: InputStream?): String {
    if (input == null) return ""
    input.use { stream ->
      val output = java.io.ByteArrayOutputStream()
      val buffer = ByteArray(8192)
      var total = 0
      while (true) {
        val count = stream.read(buffer)
        if (count < 0) break
        total += count
        if (total > 1_048_576) throw IllegalStateException("Backend response was too large")
        output.write(buffer, 0, count)
      }
      return output.toString(Charsets.UTF_8.name())
    }
  }
}

class BackendListenerService : Service() {
  private val stopping = AtomicBoolean(false)
  private val wakeLock = Object()
  private val connectionLock = Any()
  private val workerStateGate = Any()
  private val mainHandler = Handler(Looper.getMainLooper())
  @Volatile private var worker: Thread? = null
  @Volatile private var activeConnection: HttpURLConnection? = null
  @Volatile private var forceCatalogSync = true
  private var backoffMs = 1_000L
  private var lastHeartbeatAt = 0L

  private val userPresentReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
      if (intent?.action == Intent.ACTION_USER_PRESENT) signalWorker()
    }
  }

  override fun onCreate() {
    super.onCreate()
    synchronized(lifecycleMonitor) {
      currentInstance = this
      running = true
      lifecycleMonitor.notifyAll()
    }
    createNotificationChannel()
    registerUserPresentReceiver()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    startInForeground("Connecting to backend")
    if (intent?.action == ACTION_STOP) {
      UssdAutomationStore.setBackendDesiredRunning(this, false, "stopping")
      requestWorkerStop()
      return START_NOT_STICKY
    }
    if (intent?.action == ACTION_SYNC) forceCatalogSync = true
    val config = BackendController.configuration(this)
    if (config == null || !config.desiredRunning) {
      requestWorkerStop()
      return START_NOT_STICKY
    }
    if (stopping.get()) return START_NOT_STICKY
    startWorkerIfNeeded(config)
    signalWorker()
    return START_STICKY
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onDestroy() {
    requestWorkerStop(scheduleServiceStop = false)
    val savedState = UssdAutomationStore.backendConfiguration(this)["state"]?.toString().orEmpty()
    val state = when {
      savedState == "auth_expired" -> "auth_expired"
      BackendController.configuration(this)?.desiredRunning == true -> "disconnected"
      else -> "stopped"
    }
    UssdAutomationStore.updateBackendConnection(this, false, state)
    try { unregisterReceiver(userPresentReceiver) } catch (_: Exception) { }
    super.onDestroy()
    val remainingWorker = worker
    if (remainingWorker?.isAlive == true) {
      Thread({
        try { remainingWorker.join() } catch (_: InterruptedException) { }
        markInstanceStopped(this)
      }, "ussd-backend-shutdown").start()
    } else {
      markInstanceStopped(this)
    }
  }

  private fun startWorkerIfNeeded(config: BackendConfig) {
    if (worker?.isAlive == true) return
    worker = Thread({ runLoop(config) }, "ussd-backend-listener").apply {
      isDaemon = true
      start()
    }
  }

  private fun runLoop(config: BackendConfig) {
    try {
      while (isWorkerCurrent(config)) {
      try {
        val pending = readPendingJob()
        if (pending != null) {
          if (System.currentTimeMillis() - lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS) sendHeartbeat(config)
          if (forceCatalogSync) {
            publishCatalog(config)
            forceCatalogSync = false
          }
          processPending(config, pending)
          backoffMs = 1_000L
          waitForSignal(if (isDeviceLocked()) 15_000L else 1_000L)
          continue
        }
        if (forceCatalogSync) {
          publishCatalog(config)
          forceCatalogSync = false
        }
        if (System.currentTimeMillis() - lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS) sendHeartbeat(config)
        poll(config)
        backoffMs = 1_000L
      } catch (_: BackendWorkerStoppedException) {
        break
      } catch (_: BackendAuthenticationException) {
        UssdAutomationStore.setBackendDesiredRunning(this, false, "auth_expired")
        UssdAutomationStore.updateBackendConnection(
          this,
          false,
          "auth_expired",
          "Backend authentication expired. Reconnect this phone from the app."
        )
        requestWorkerStop()
        break
      } catch (error: Exception) {
        if (!isWorkerCurrent(config)) break
        val message = safeNetworkMessage(error)
        UssdAutomationStore.updateBackendConnection(this, false, "reconnecting", message)
        updateNotification("Connection lost - retrying")
        waitForSignal(backoffMs)
        backoffMs = min(backoffMs * 2L, MAX_BACKOFF_MS)
      }
    }
    } finally {
      worker = null
      requestWorkerStop()
    }
  }

  private fun poll(config: BackendConfig) {
    requireWorkerCurrent(config)
    updateNotification("Connected - waiting for requests")
    val response = authorized(config, "/api/device/jobs/next?wait=25", "GET", null, 35_000)
    markContact(config, "waiting")
    if (response.status == 204) return
    if (response.status !in 200..299) throw IllegalStateException("Job poll failed (HTTP ${response.status})")
    val envelope = try { JSONObject(response.body) } catch (_: Exception) { throw IllegalStateException("Backend returned an invalid job") }
    val raw = envelope.optJSONObject("job") ?: throw IllegalStateException("Backend job was missing")
    val serverTime = envelope.optLong("serverTime", 0L)
    if (serverTime <= 0L) throw IllegalStateException("Backend job response did not include server time")
    requireWorkerCurrent(config)
    acceptJob(config, PendingJob.fromServer(raw, serverTime, currentBootCount()))
  }

  private fun acceptJob(config: BackendConfig, job: PendingJob) {
    requireWorkerCurrent(config)
    if (UssdAutomationStore.isBackendJobProcessed(this, job.id)) {
      postStatus(config, job.id, "failed", "duplicate_job", "")
      return
    }
    val existing = readPendingJob()
    if (existing != null) {
      if (existing.id != job.id) postStatus(config, job.id, "failed", "device_busy", "")
      return
    }
    val validationError = validateJob(job)
    if (validationError != null) {
      postStatus(config, job.id, "failed", validationError, "")
      withCurrentWorker(config) { UssdAutomationStore.completeBackendJob(this, job.id) }
      return
    }
    val initialJobSaved = withCurrentWorker(config) {
      UssdAutomationStore.saveBackendPendingJob(this, job.toJson().toString())
    }
    if (!initialJobSaved) {
      postStatus(config, job.id, "failed", "secure_storage_unavailable", "")
      return
    }
    val message = if (isDeviceLocked()) "waiting_for_unlock" else "accepted"
    if (!postStatus(config, job.id, "accepted", message, "")) {
      val completed = withCurrentWorker(config) { UssdAutomationStore.completeBackendJob(this, job.id) }
      if (!completed) throw IllegalStateException("Could not finish server-final job state")
      return
    }
    job.acceptedReported = true
    savePending(config, job)
  }

  private fun processPending(config: BackendConfig, job: PendingJob) {
    requireWorkerCurrent(config)
    if (job.phase == "reporting") {
      postStatus(config, job.id, job.terminalStatus, job.message, job.sessionId)
      val completed = withCurrentWorker(config) { UssdAutomationStore.completeBackendJob(this, job.id) }
      if (!completed) throw IllegalStateException("Could not finish job state")
      updateNotification("Connected - waiting for requests")
      return
    }
    if (job.phase == "launching") {
      withCurrentWorker(config) {
        UssdAutomationStore.stopBackendJob(
          this,
          job.id,
          "interrupted",
          "A backend-triggered launch was interrupted before its outcome could be confirmed."
        )
      }
      finishJob(config, job, "failed", "launch_interrupted_outcome_uncertain", job.sessionId)
      return
    }
    if (job.phase == "running") {
      if (!reportRunning(config, job)) return
      monitorRunningJob(config, job)
      return
    }
    if (job.isExpired(currentBootCount())) {
      finishJob(config, job, "failed", "job_expired", "")
      return
    }
    if (!job.acceptedReported) {
      if (!postStatus(config, job.id, "accepted", if (isDeviceLocked()) "waiting_for_unlock" else "accepted", "")) {
        val completed = withCurrentWorker(config) { UssdAutomationStore.completeBackendJob(this, job.id) }
        if (!completed) throw IllegalStateException("Could not finish server-final job state")
        return
      }
      job.acceptedReported = true
      savePending(config, job)
    }
    if (isDeviceLocked()) {
      UssdAutomationStore.updateBackendConnection(this, true, "waiting_for_unlock", "", false)
      updateNotification("Request queued - unlock phone to continue")
      return
    }

    val flow = findFlow(job.flowId)
    if (flow == null) {
      finishJob(config, job, "failed", "saved_flow_not_found", "")
      return
    }
    val flowUpdatedAt = flow["updatedAt"] as? Long ?: (flow["updatedAt"] as? Number)?.toLong() ?: 0L
    if (flowUpdatedAt != job.flowUpdatedAt) {
      finishJob(config, job, "failed", "saved_flow_changed", "")
      return
    }
    @Suppress("UNCHECKED_CAST")
    val replies = flow["replies"] as? List<String> ?: emptyList()
    val (resolved, error) = FlowTemplates.substitute(replies, job.variables)
    if (resolved == null) {
      finishJob(config, job, "failed", error ?: "invalid_variables", "")
      return
    }
    if (isDeviceLocked()) {
      UssdAutomationStore.updateBackendConnection(this, true, "waiting_for_unlock", "", false)
      updateNotification("Request queued - unlock phone to continue")
      return
    }

    job.phase = "launching"
    savePending(config, job) // Durable uncertainty barrier: a crash after this point must never redial.
    val result = withCurrentWorker(config) {
      val launchResult = UssdAutomationLauncher.start(
        this,
        flow["code"]?.toString().orEmpty(),
        resolved,
        (flow["subscriptionId"] as? Number)?.toInt() ?: -1,
        flow["name"]?.toString().orEmpty(),
        preserveReplyWhitespace = true,
        backendJobId = job.id
      )
      if (launchResult.started) {
        // Do not release the stop gate between placing the call and persisting the
        // corresponding running state. Stop therefore orders entirely before the
        // dial or entirely after this durable barrier.
        job.phase = "running"
        job.sessionId = launchResult.sessionId
        job.runningReported = false
        val runningSaved = UssdAutomationStore.saveBackendPendingJob(this, job.toJson().toString())
        if (!runningSaved) {
          UssdAutomationStore.stopBackendJob(
            this,
            job.id,
            "interrupted",
            "USSD was started, but its backend running state could not be saved safely."
          )
          // The durable pending record is deliberately left at `launching`; recovery
          // treats its outcome as uncertain and never dials it again.
          job.phase = "launching"
          job.sessionId = ""
          job.runningReported = false
          throw IllegalStateException("Could not save the backend running barrier securely")
        }
      }
      launchResult
    }
    if (!result.started) {
      finishJob(config, job, "failed", result.code.lowercase(), "")
      return
    }
    if (!reportRunning(config, job)) return
    updateNotification("USSD request is running")
  }

  private fun reportRunning(config: BackendConfig, job: PendingJob): Boolean {
    if (job.runningReported) return true
    if (!postStatus(config, job.id, "running", "ussd_started", job.sessionId)) {
      withCurrentWorker(config) {
        UssdAutomationStore.stopBackendJob(
          this,
          job.id,
          "interrupted",
          "The backend had already finalized this request, so its USSD flow was stopped."
        )
      }
      val completed = withCurrentWorker(config) { UssdAutomationStore.completeBackendJob(this, job.id) }
      if (!completed) throw IllegalStateException("Could not finish server-final job state")
      return false
    }
    job.runningReported = true
    savePending(config, job)
    return true
  }

  private fun monitorRunningJob(config: BackendConfig, job: PendingJob) {
    requireWorkerCurrent(config)
    val automation = UssdAutomationStore.getAutomationStatus(this)
    val sessionId = automation["sessionId"]?.toString().orEmpty()
    val status = automation["status"]?.toString().orEmpty()
    if (sessionId != job.sessionId) {
      finishJob(config, job, "failed", "automation_session_changed", job.sessionId)
      return
    }
    if (status in setOf("running", "starting")) return
    val terminal = when (status) {
      "completed" -> "succeeded"
      "cancelled" -> "cancelled"
      else -> "failed"
    }
    finishJob(config, job, terminal, status.ifEmpty { "automation_ended" }, job.sessionId)
  }

  private fun validateJob(job: PendingJob): String? {
    if (!job.id.matches(Regex("^[A-Za-z0-9._-]{1,128}$"))) return "invalid_job_id"
    if (job.flowId.isBlank() || job.flowId.length > 128) return "invalid_flow_id"
    if (
      job.createdAt <= 0L || job.expiresAt <= job.createdAt ||
      job.expiresAt - job.createdAt > 300_000L || job.isExpired(currentBootCount())
    ) return "job_expired_or_invalid"
    val flow = findFlow(job.flowId) ?: return "saved_flow_not_found"
    val updatedAt = (flow["updatedAt"] as? Number)?.toLong() ?: 0L
    if (updatedAt != job.flowUpdatedAt) return "saved_flow_changed"
    @Suppress("UNCHECKED_CAST")
    val replies = flow["replies"] as? List<String> ?: return "saved_flow_invalid"
    return FlowTemplates.substitute(replies, job.variables).second
  }

  private fun findFlow(id: String): Map<String, Any>? =
    UssdAutomationStore.getSavedFlows(this).firstOrNull { it["id"]?.toString() == id }

  private fun finishJob(config: BackendConfig, job: PendingJob, status: String, message: String, sessionId: String) {
    job.phase = "reporting"
    job.terminalStatus = status
    job.message = message.take(160)
    job.sessionId = sessionId
    savePending(config, job)
  }

  private fun savePending(config: BackendConfig, job: PendingJob) {
    val saved = withCurrentWorker(config) {
      UssdAutomationStore.saveBackendPendingJob(this, job.toJson().toString())
    }
    if (!saved) {
      throw IllegalStateException("Could not save backend job state securely")
    }
  }

  private fun readPendingJob(): PendingJob? {
    val raw = UssdAutomationStore.backendPendingJob(this)
    if (raw.isEmpty()) {
      if (UssdAutomationStore.isBackendPendingJobPresent(this)) {
        throw IllegalStateException("Pending request state cannot be read safely")
      }
      return null
    }
    return try { PendingJob.fromStored(JSONObject(raw)) } catch (_: Exception) {
      throw IllegalStateException("Pending request state is invalid and will not be retried")
    }
  }

  private fun publishCatalog(config: BackendConfig) {
    val flows = JSONArray()
    for (flow in UssdAutomationStore.getSavedFlows(this)) {
      @Suppress("UNCHECKED_CAST")
      val replies = flow["replies"] as? List<String> ?: continue
      val validation = FlowTemplates.validateSavedReplies(replies)
      if (validation.error != null) continue
      flows.put(JSONObject()
        .put("id", flow["id"]?.toString().orEmpty())
        .put("name", flow["name"]?.toString().orEmpty())
        .put("requiredVariables", JSONArray(validation.requiredVariables))
        .put("updatedAt", (flow["updatedAt"] as? Number)?.toLong() ?: 0L))
    }
    val response = authorized(config, "/api/device/catalog", "PUT", JSONObject().put("flows", flows), 15_000)
    if (response.status !in 200..299) throw IllegalStateException("Catalog sync failed (HTTP ${response.status})")
    markContact(config, "connected")
  }

  private fun sendHeartbeat(config: BackendConfig) {
    val pendingId = readPendingJob()?.id.orEmpty()
    val body = JSONObject()
      .put("name", config.deviceName)
      .put("appVersion", packageManager.getPackageInfo(packageName, 0).versionName ?: "1")
      .put("androidVersion", Build.VERSION.RELEASE ?: Build.VERSION.SDK_INT.toString())
      .put("state", if (pendingId.isEmpty()) "ready" else "busy")
    if (pendingId.isNotEmpty()) body.put("pendingJobId", pendingId)
    val response = authorized(config, "/api/device/heartbeat", "POST", body, 15_000)
    if (response.status !in 200..299) throw IllegalStateException("Heartbeat failed (HTTP ${response.status})")
    val responseBody = try { JSONObject(response.body) } catch (_: Exception) {
      throw IllegalStateException("Backend returned an invalid heartbeat response")
    }
    if (responseBody.optBoolean("catalogRequired", false)) forceCatalogSync = true
    lastHeartbeatAt = System.currentTimeMillis()
    markContact(config, "connected")
  }

  /** Returns false only when the backend explicitly confirms the run is already final or gone. */
  private fun postStatus(config: BackendConfig, id: String, status: String, message: String, sessionId: String): Boolean {
    val body = JSONObject().put("status", status)
    if (message.isNotEmpty()) body.put("message", message)
    if (sessionId.isNotEmpty()) body.put("sessionId", sessionId)
    val path = "/api/device/jobs/${android.net.Uri.encode(id)}/status"
    val response = authorized(config, path, "POST", body, 15_000)
    if (response.status !in 200..299) {
      val errorCode = try {
        JSONObject(response.body).optJSONObject("error")?.optString("code").orEmpty()
      } catch (_: Exception) { "" }
      val serverFinal =
        (response.status == 404 && errorCode == "RUN_NOT_FOUND") ||
          (response.status == 409 && errorCode == "RUN_ALREADY_FINISHED")
      if (serverFinal) {
        markContact(config, "connected")
        return false
      }
      throw IllegalStateException("Job status update failed (HTTP ${response.status})")
    }
    markContact(config, "connected")
    return true
  }

  private fun authorized(config: BackendConfig, path: String, method: String, body: JSONObject?, timeout: Int): BackendHttp.Response {
    requireWorkerCurrent(config)
    val response = BackendHttp.request(
      config.baseUrl,
      path,
      method,
      "Device ${config.deviceToken}",
      body,
      timeout,
      onOpened = { connection ->
        synchronized(connectionLock) {
          requireWorkerCurrent(config)
          activeConnection = connection
        }
      },
      onClosed = { connection ->
        synchronized(connectionLock) {
          if (activeConnection === connection) activeConnection = null
        }
      }
    )
    requireWorkerCurrent(config)
    if (response.status == 401 || response.status == 403) throw BackendAuthenticationException()
    return response
  }

  private fun markContact(config: BackendConfig, state: String) {
    requireWorkerCurrent(config)
    UssdAutomationStore.updateBackendConnection(this, true, state, "", true)
  }

  private fun isDeviceLocked(): Boolean =
    (getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager).isDeviceLocked

  private fun currentBootCount(): Int =
    try { Settings.Global.getInt(contentResolver, Settings.Global.BOOT_COUNT) } catch (_: Exception) { -1 }

  private fun safeNetworkMessage(error: Exception): String = when (error) {
    is java.net.SocketTimeoutException -> "Backend did not respond in time"
    is java.net.UnknownHostException -> "Backend host could not be reached"
    is javax.net.ssl.SSLException -> "Secure backend connection failed"
    else -> error.message?.takeIf { !it.contains("token", ignoreCase = true) }?.take(160) ?: "Backend connection failed"
  }

  private fun waitForSignal(milliseconds: Long) {
    synchronized(wakeLock) {
      try { wakeLock.wait(milliseconds) } catch (_: InterruptedException) { }
    }
  }

  private fun signalWorker() = synchronized(wakeLock) { wakeLock.notifyAll() }

  private fun requestWorkerStop(scheduleServiceStop: Boolean = true) {
    synchronized(workerStateGate) {
      stopping.set(true)
    }
    cancelActiveConnection()
    signalWorker()
    worker?.interrupt()
    if (scheduleServiceStop && worker?.isAlive != true) {
      mainHandler.post {
        if (worker?.isAlive != true) {
          stopForeground(STOP_FOREGROUND_REMOVE)
          stopSelf()
        }
      }
    }
  }

  private fun cancelActiveConnection() {
    synchronized(connectionLock) {
      activeConnection?.disconnect()
      activeConnection = null
    }
  }

  private fun isWorkerCurrent(config: BackendConfig): Boolean {
    if (stopping.get()) return false
    val live = BackendController.configuration(this) ?: return false
    return live.desiredRunning && live.generation == config.generation
  }

  private fun requireWorkerCurrent(config: BackendConfig) {
    if (!isWorkerCurrent(config)) throw BackendWorkerStoppedException()
  }

  private fun <T> withCurrentWorker(config: BackendConfig, action: () -> T): T =
    synchronized(workerStateGate) {
      requireWorkerCurrent(config)
      action()
    }

  private fun createNotificationChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    manager.createNotificationChannel(NotificationChannel(CHANNEL_ID, "Backend listener", NotificationManager.IMPORTANCE_LOW).apply {
      description = "Shows when USSD Flow is accepting requests from your configured backend"
      setShowBadge(false)
    })
  }

  private fun notification(text: String): Notification {
    val stopIntent = Intent(this, BackendListenerService::class.java).setAction(ACTION_STOP)
    val stopPending = PendingIntent.getService(this, 2, stopIntent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
    val launchPending = launchIntent?.let {
      PendingIntent.getActivity(this, 1, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(this, CHANNEL_ID) else Notification.Builder(this)
    return builder
      .setSmallIcon(com.fikre.ussddialer.R.drawable.ic_backend_notification)
      .setContentTitle("USSD Flow backend")
      .setContentText(text)
      .setContentIntent(launchPending)
      .setOngoing(true)
      .setCategory(Notification.CATEGORY_SERVICE)
      .setVisibility(Notification.VISIBILITY_SECRET)
      .addAction(Notification.Action.Builder(null, "Stop", stopPending).build())
      .build()
  }

  private fun startInForeground(text: String) {
    val value = notification(text)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0
      startForeground(NOTIFICATION_ID, value, type)
    } else startForeground(NOTIFICATION_ID, value)
  }

  private fun updateNotification(text: String) {
    (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).notify(NOTIFICATION_ID, notification(text))
  }

  private fun registerUserPresentReceiver() {
    val filter = IntentFilter(Intent.ACTION_USER_PRESENT)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) registerReceiver(userPresentReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
    else @Suppress("DEPRECATION") registerReceiver(userPresentReceiver, filter)
  }

  private data class PendingJob(
    val id: String,
    val flowId: String,
    val flowUpdatedAt: Long,
    val variables: Map<String, String>,
    val createdAt: Long,
    val expiresAt: Long,
    val deadlineElapsed: Long,
    val acceptedBootCount: Int,
    var phase: String = "accepted",
    var acceptedReported: Boolean = false,
    var runningReported: Boolean = false,
    var terminalStatus: String = "",
    var message: String = "",
    var sessionId: String = ""
  ) {
    fun toJson(): JSONObject = JSONObject()
      .put("id", id).put("flowId", flowId).put("flowUpdatedAt", flowUpdatedAt)
      .put("variables", JSONObject(variables)).put("createdAt", createdAt).put("expiresAt", expiresAt)
      .put("deadlineElapsed", deadlineElapsed).put("acceptedBootCount", acceptedBootCount)
      .put("phase", phase).put("acceptedReported", acceptedReported).put("runningReported", runningReported)
      .put("terminalStatus", terminalStatus)
      .put("message", message).put("sessionId", sessionId)

    fun isExpired(currentBootCount: Int): Boolean =
      acceptedBootCount < 0 || currentBootCount < 0 || acceptedBootCount != currentBootCount ||
        deadlineElapsed <= 0L || SystemClock.elapsedRealtime() >= deadlineElapsed

    companion object {
      fun fromServer(json: JSONObject, serverTime: Long, bootCount: Int): PendingJob {
        val remaining = (json.optLong("expiresAt") - serverTime).coerceIn(0L, 300_000L)
        return parse(json, false, SystemClock.elapsedRealtime() + remaining, bootCount)
      }
      fun fromStored(json: JSONObject): PendingJob = parse(
        json,
        true,
        json.optLong("deadlineElapsed", 0L),
        json.optInt("acceptedBootCount", Int.MIN_VALUE)
      )

      private fun parse(json: JSONObject, stored: Boolean, deadlineElapsed: Long, acceptedBootCount: Int): PendingJob {
        val variablesJson = json.optJSONObject("variables") ?: JSONObject()
        val variables = linkedMapOf<String, String>()
        val keys = variablesJson.keys()
        while (keys.hasNext()) {
          val key = keys.next()
          val value = variablesJson.opt(key)
          if (value !is String) throw IllegalArgumentException("Variables must be strings")
          variables[key] = value
        }
        return PendingJob(
          json.optString("id"), json.optString("flowId"), json.optLong("flowUpdatedAt"), variables,
          json.optLong("createdAt"), json.optLong("expiresAt"), deadlineElapsed, acceptedBootCount,
          if (stored) json.optString("phase", "accepted") else "accepted",
          stored && json.optBoolean("acceptedReported", false),
          stored && json.optBoolean("runningReported", false),
          if (stored) json.optString("terminalStatus") else "",
          if (stored) json.optString("message") else "",
          if (stored) json.optString("sessionId") else ""
        )
      }
    }
  }

  companion object {
    const val ACTION_START = "com.fikre.ussddialer.backend.START"
    const val ACTION_STOP = "com.fikre.ussddialer.backend.STOP"
    const val ACTION_SYNC = "com.fikre.ussddialer.backend.SYNC"
    private const val CHANNEL_ID = "ussd_backend_listener"
    private const val NOTIFICATION_ID = 6671
    private const val HEARTBEAT_INTERVAL_MS = 60_000L
    private const val MAX_BACKOFF_MS = 60_000L
    private val lifecycleMonitor = Object()
    @Volatile private var running = false
    @Volatile private var currentInstance: BackendListenerService? = null
    fun isRunning(): Boolean = running
    fun isFullyStopped(): Boolean = synchronized(lifecycleMonitor) {
      !running && currentInstance == null
    }

    fun stopAndAwait(timeoutMs: Long): Boolean {
      val deadline = SystemClock.elapsedRealtime() + timeoutMs
      synchronized(lifecycleMonitor) {
        currentInstance?.requestWorkerStop()
        while (running || currentInstance != null) {
          val remaining = deadline - SystemClock.elapsedRealtime()
          if (remaining <= 0L) return false
          try { lifecycleMonitor.wait(remaining) } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
            return false
          }
        }
        return true
      }
    }

    private fun markInstanceStopped(instance: BackendListenerService) {
      synchronized(lifecycleMonitor) {
        if (currentInstance === instance) currentInstance = null
        running = currentInstance != null
        lifecycleMonitor.notifyAll()
      }
    }
  }
}
