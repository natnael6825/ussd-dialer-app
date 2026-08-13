package com.fikre.ussddialer

import android.accessibilityservice.AccessibilityService
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.Toast
import org.json.JSONArray
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class UssdAutomationService : AccessibilityService() {
  private val handler = Handler(Looper.getMainLooper())
  private var pendingSignature: String? = null
  private var pendingRunnable: Runnable? = null
  private var recordingDraft: String = ""
  private var recordingMenuSignature: String = ""
  private var recordingId: Long = 0L

  private val watchdog = object : Runnable {
    override fun run() {
      if (!connected) return
      if (UssdAutomationStore.reapExpiredAutomation(this@UssdAutomationService)) {
        clearPendingAction()
        Toast.makeText(this@UssdAutomationService, "USSD Flow timed out while waiting for a response", Toast.LENGTH_SHORT).show()
      }
      if (UssdAutomationStore.reapExpiredRecording(this@UssdAutomationService)) {
        resetRecordingMemory()
        Toast.makeText(this@UssdAutomationService, "USSD recording timed out", Toast.LENGTH_SHORT).show()
      }
      handler.postDelayed(this, WATCHDOG_INTERVAL_MS)
    }
  }

  override fun onServiceConnected() {
    super.onServiceConnected()
    connected = true
    clearPendingAction()
    resetRecordingMemory()
    if (UssdAutomationStore.interruptStalePendingAction(this)) {
      Toast.makeText(this, "A previously interrupted USSD step was stopped safely", Toast.LENGTH_SHORT).show()
    }
    handler.removeCallbacks(watchdog)
    handler.post(watchdog)
  }

  override fun onAccessibilityEvent(event: AccessibilityEvent?) {
    val packageName = event?.packageName?.toString().orEmpty()
    if (packageName !in ALLOWED_PACKAGES) return
    if (UssdAutomationStore.isRecording(this)) {
      handleRecordingEvent(event ?: return)
      return
    }
    if (!UssdAutomationStore.isArmed(this)) return
    if (UssdAutomationStore.reapExpiredAutomation(this)) {
      clearPendingAction()
      Toast.makeText(this, "USSD Flow timed out", Toast.LENGTH_SHORT).show()
      return
    }

    val root = rootInActiveWindow ?: return
    if (root.packageName?.toString() !in ALLOWED_PACKAGES) return
    val snapshot = snapshot(root) ?: return
    if (!UssdAutomationStore.isFreshResponse(this, snapshot.fingerprint)) return

    val reply = UssdAutomationStore.nextReply(this)
    if (reply == null) {
      handleTerminalResponse(snapshot)
      return
    }

    val signature = "$packageName|${snapshot.fingerprint}"
    if (pendingSignature != null && pendingSignature != signature) {
      failAutomation("response_changed", "The USSD response changed while a reply was pending.")
      return
    }
    if (signature == UssdAutomationStore.lastSignature(this) || signature == pendingSignature) return

    if (reply.equals(CANCEL_COMMAND, ignoreCase = true)) {
      if (!snapshot.hasCancel) {
        failAutomation("cancel_control_not_found", "The USSD cancel control changed. Cancel the session manually.")
        return
      }
      scheduleAction(signature, snapshot, reply, true)
      return
    }

    if (!snapshot.isInteractive) {
      UssdAutomationStore.finishWithResponse(
        this,
        "unexpected_end",
        "The USSD session ended before all replies were sent.",
        snapshot.response,
        "unexpected_end"
      )
      Toast.makeText(this, "USSD ended before the flow was complete", Toast.LENGTH_SHORT).show()
      return
    }
    scheduleAction(signature, snapshot, reply, false)
  }

  override fun onInterrupt() {
    interruptActiveWork("Accessibility interrupted the USSD session.")
  }

  override fun onUnbind(intent: Intent?): Boolean {
    connected = false
    interruptActiveWork("USSD automation was disconnected.")
    return super.onUnbind(intent)
  }

  override fun onDestroy() {
    connected = false
    interruptActiveWork("USSD automation stopped unexpectedly.")
    super.onDestroy()
  }

  private fun scheduleAction(signature: String, original: WindowSnapshot, reply: String, cancel: Boolean) {
    clearPendingAction()
    pendingSignature = signature
    lateinit var task: Runnable
    task = Runnable {
      try {
        if (!UssdAutomationStore.isArmed(this) || pendingSignature != signature) return@Runnable
        val liveRoot = rootInActiveWindow
        if (liveRoot == null || liveRoot.packageName?.toString() != original.packageName) {
          failAutomation("window_interrupted", "The USSD window disappeared before the next step.")
          return@Runnable
        }
        val live = snapshot(liveRoot)
        if (live == null || live.fingerprint != original.fingerprint) {
          failAutomation("response_changed", "The USSD response changed before the saved reply could be sent.")
          return@Runnable
        }
        if (!UssdAutomationStore.beginPendingAction(this, signature)) {
          failAutomation("storage_error", "The next USSD step could not be saved safely.")
          return@Runnable
        }

        if (cancel) {
          val cancelButton = findFirst(liveRoot) { node ->
            node.isClickable && node.isVisibleToUser && nodeLabel(node) in CANCEL_LABELS
          }
          if (cancelButton == null || !cancelButton.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
            UssdAutomationStore.failPendingAction(this, "cancel_failed", "The USSD cancel control did not respond.")
            Toast.makeText(this, "Could not cancel USSD automatically", Toast.LENGTH_SHORT).show()
            return@Runnable
          }
          if (!UssdAutomationStore.completeSuccessfulAction(this, signature, live.response, reply, true)) {
            UssdAutomationStore.emergencyDisarm(this)
            Toast.makeText(this, "USSD was cancelled, but its history could not be saved", Toast.LENGTH_SHORT).show()
            return@Runnable
          }
          Toast.makeText(this, "USSD Flow cancelled the session", Toast.LENGTH_SHORT).show()
          return@Runnable
        }

        val liveInput = findFirst(liveRoot) { it.isEditable && it.isVisibleToUser }
        val liveSend = findFirst(liveRoot) { node ->
          node.isClickable && node.isVisibleToUser && nodeLabel(node) in SEND_LABELS
        }
        if (liveInput == null || liveSend == null || !live.hasCancel) {
          UssdAutomationStore.failPendingAction(this, "controls_changed", "The USSD controls changed before the reply was sent.")
          Toast.makeText(this, "USSD controls changed. The flow was stopped.", Toast.LENGTH_SHORT).show()
          return@Runnable
        }
        val arguments = Bundle().apply {
          putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, reply)
        }
        val entered = liveInput.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments)
        val sent = entered && liveSend.performAction(AccessibilityNodeInfo.ACTION_CLICK)
        if (!sent) {
          UssdAutomationStore.failPendingAction(this, "send_failed", "The phone did not accept the saved USSD reply.")
          Toast.makeText(this, "Could not send the saved USSD reply", Toast.LENGTH_SHORT).show()
          return@Runnable
        }
        if (!UssdAutomationStore.completeSuccessfulAction(this, signature, live.response, reply, false)) {
          UssdAutomationStore.emergencyDisarm(this)
          Toast.makeText(this, "Reply sent, but progress could not be saved safely", Toast.LENGTH_SHORT).show()
          return@Runnable
        }
        Toast.makeText(this, "USSD Flow sent step ${UssdAutomationStore.currentIndex(this)}", Toast.LENGTH_SHORT).show()
      } finally {
        if (pendingRunnable === task) {
          pendingRunnable = null
          pendingSignature = null
        }
      }
    }
    pendingRunnable = task
    handler.postDelayed(task, REPLY_DELAY_MS)
  }

  private fun handleTerminalResponse(snapshot: WindowSnapshot) {
    if (snapshot.isInteractive) {
      UssdAutomationStore.finishWithResponse(
        this,
        "needs_attention",
        "USSD requested another reply after the saved flow ended.",
        snapshot.response,
        "unexpected_prompt"
      )
      Toast.makeText(this, "USSD needs another reply. Continue manually.", Toast.LENGTH_SHORT).show()
      return
    }

    val liveRoot = rootInActiveWindow
    val finishButton = liveRoot?.let { root ->
      findFirst(root) { node -> node.isClickable && node.isVisibleToUser && nodeLabel(node) in FINISH_LABELS }
    }
    val closed = finishButton?.performAction(AccessibilityNodeInfo.ACTION_CLICK) ?: true
    val status = if (closed) "completed" else "close_failed"
    val message = if (closed) "USSD flow completed." else "The flow completed, but the USSD window must be closed manually."
    UssdAutomationStore.finishWithResponse(this, status, message, snapshot.response, "terminal")
    Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
  }

  private fun failAutomation(status: String, message: String) {
    clearPendingAction()
    UssdAutomationStore.stop(this, status, message)
    Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
  }

  private fun clearPendingAction() {
    pendingRunnable?.let(handler::removeCallbacks)
    pendingRunnable = null
    pendingSignature = null
  }

  private fun interruptActiveWork(message: String) {
    handler.removeCallbacks(watchdog)
    clearPendingAction()
    UssdAutomationStore.interruptActive(this, message)
    resetRecordingMemory()
    if (connected) handler.post(watchdog)
  }

  private fun resetRecordingMemory() {
    recordingDraft = ""
    recordingMenuSignature = ""
    recordingId = 0L
  }

  private data class WindowSnapshot(
    val packageName: String,
    val response: String,
    val fingerprint: String,
    val isInteractive: Boolean,
    val hasCancel: Boolean
  )

  private fun snapshot(root: AccessibilityNodeInfo): WindowSnapshot? {
    val rootPackage = root.packageName?.toString().orEmpty()
    if (rootPackage !in ALLOWED_PACKAGES) return null
    val response = collectMenuText(root)
      .map(::normalizeText)
      .filter { it.isNotEmpty() && it.lowercase() !in ALL_BUTTON_LABELS }
      .distinct()
      .joinToString("|")
    if (response.isBlank()) return null
    val hasInput = findFirst(root) { it.isEditable && it.isVisibleToUser } != null
    val hasSend = findFirst(root) { node ->
      node.isClickable && node.isVisibleToUser && nodeLabel(node) in SEND_LABELS
    } != null
    val hasCancel = findFirst(root) { node ->
      node.isClickable && node.isVisibleToUser && nodeLabel(node) in CANCEL_LABELS
    } != null
    val hasFinish = findFirst(root) { node ->
      node.isClickable && node.isVisibleToUser && nodeLabel(node) in FINISH_LABELS
    } != null
    val interactive = hasInput && hasSend && hasCancel
    if (!interactive && !(hasFinish && !hasInput)) return null
    val fingerprint = "$rootPackage|$response"
    return WindowSnapshot(rootPackage, response, fingerprint, interactive, hasCancel)
  }

  private fun handleRecordingEvent(event: AccessibilityEvent) {
    val liveRecordingId = UssdAutomationStore.recordingId(this)
    if (liveRecordingId != recordingId) {
      resetRecordingMemory()
      recordingId = liveRecordingId
    }
    if (UssdAutomationStore.isRecordingExpired(this)) {
      UssdAutomationStore.finishRecording(this, "timed_out")
      resetRecordingMemory()
      Toast.makeText(this, "USSD recording timed out", Toast.LENGTH_SHORT).show()
      return
    }
    if (event.eventType == AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED) {
      val source = event.source ?: return
      if (source.isEditable && !source.isPassword) {
        val draft = source.text?.toString()?.trim().orEmpty()
        if (draft.isNotEmpty()) {
          recordingDraft = draft
          UssdAutomationStore.saveRecordingDraft(this, draft)
        }
      }
      return
    }
    val root = rootInActiveWindow
    val menuSignature = root?.let { collectMenuText(it).filterNot { text -> text.lowercase() in ALL_BUTTON_LABELS }.joinToString("|") }.orEmpty()

    if (event.eventType == AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED || event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
      if (recordingMenuSignature.isNotEmpty() && menuSignature.isNotEmpty() && menuSignature != recordingMenuSignature) {
        commitRecordingDraft()
      }
      if (menuSignature.isNotEmpty()) recordingMenuSignature = menuSignature
      val input = root?.let { findFirst(it) { node -> node.isEditable && node.isVisibleToUser && !node.isPassword } }
      input?.text?.toString()?.trim()?.takeIf(String::isNotEmpty)?.let { draft ->
        recordingDraft = draft
        UssdAutomationStore.saveRecordingDraft(this, draft)
      }
      return
    }

    if (event.eventType != AccessibilityEvent.TYPE_VIEW_CLICKED) return
    val clicked = event.source ?: return
    val label = clickableLabel(clicked)

    if (label in CANCEL_LABELS || hasAncestorLabel(clicked, CANCEL_LABELS)) {
      commitRecordingDraft()
      UssdAutomationStore.recordManualReply(this, CANCEL_COMMAND)
      UssdAutomationStore.finishRecording(this, "cancelled")
      resetRecordingMemory()
      Toast.makeText(this, "USSD Flow recorded CANCEL", Toast.LENGTH_SHORT).show()
      return
    }

    if (label in SEND_LABELS || hasAncestorLabel(clicked, SEND_LABELS)) {
      val input = root?.let { findFirst(it) { node -> node.isEditable && node.isVisibleToUser } }
      if (input == null) {
        if (label in FINISH_LABELS) UssdAutomationStore.finishRecording(this, "completed")
        return
      }
      if (input.isPassword) {
        Toast.makeText(this, "Password reply was not recorded", Toast.LENGTH_SHORT).show()
        return
      }
      input.text?.toString()?.trim()?.takeIf(String::isNotEmpty)?.let { recordingDraft = it }
      commitRecordingDraft()
      return
    }

    if (label in FINISH_LABELS) {
      UssdAutomationStore.finishRecording(this, "completed")
      resetRecordingMemory()
      Toast.makeText(this, "USSD recording complete", Toast.LENGTH_SHORT).show()
    }
  }

  private fun commitRecordingDraft() {
    val reply = recordingDraft.ifEmpty { UssdAutomationStore.recordingDraft(this) }
    if (reply.isNotEmpty() && UssdAutomationStore.recordManualReply(this, reply)) {
      Toast.makeText(this, "Reply recorded", Toast.LENGTH_SHORT).show()
    }
    recordingDraft = ""
  }

  private fun clickableLabel(node: AccessibilityNodeInfo): String {
    val own = nodeLabel(node)
    if (own.isNotEmpty()) return own
    return collectText(node).joinToString(" ").trim().lowercase()
  }

  private fun hasAncestorLabel(node: AccessibilityNodeInfo, labels: Set<String>): Boolean {
    var parent = node.parent
    repeat(3) {
      val current = parent ?: return false
      if (clickableLabel(current) in labels) return true
      parent = current.parent
    }
    return false
  }

  private fun findFirst(
    node: AccessibilityNodeInfo,
    predicate: (AccessibilityNodeInfo) -> Boolean
  ): AccessibilityNodeInfo? {
    if (predicate(node)) return node
    for (index in 0 until node.childCount) {
      val child = node.getChild(index) ?: continue
      val result = findFirst(child, predicate)
      if (result != null) return result
    }
    return null
  }

  private fun collectText(node: AccessibilityNodeInfo): List<String> {
    val result = mutableListOf<String>()
    node.text?.toString()?.trim()?.takeIf { it.isNotEmpty() }?.let(result::add)
    for (index in 0 until node.childCount) {
      node.getChild(index)?.let { result.addAll(collectText(it)) }
    }
    return result.distinct()
  }

  private fun collectMenuText(node: AccessibilityNodeInfo): List<String> {
    val result = mutableListOf<String>()
    if (!node.isEditable) {
      node.text?.toString()?.trim()?.takeIf { it.isNotEmpty() }?.let(result::add)
    }
    for (index in 0 until node.childCount) {
      node.getChild(index)?.let { result.addAll(collectMenuText(it)) }
    }
    return result.distinct()
  }

  private fun nodeLabel(node: AccessibilityNodeInfo): String =
    (node.text ?: node.contentDescription)?.toString()?.trim()?.lowercase().orEmpty()

  private fun normalizeText(value: String): String = value.replace(Regex("\\s+"), " ").trim()

  companion object {
    private const val REPLY_DELAY_MS = 1200L
    private const val WATCHDOG_INTERVAL_MS = 1_000L
    private const val CANCEL_COMMAND = "CANCEL"
    @Volatile private var connected = false

    fun isConnected(): Boolean = connected
    private val ALLOWED_PACKAGES = setOf(
    "com.android.phone",
      "com.sec.phone",
      "com.samsung.android.dialer",
      "com.samsung.android.app.telephonyui",
      "com.samsung.android.incallui",
      "com.android.server.telecom"
    )
    private val SEND_LABELS = setOf("send", "reply", "next", "ok")
    private val FINISH_LABELS = setOf("ok", "close", "dismiss")
    private val CANCEL_LABELS = setOf("cancel", "end", "exit")
    private val ALL_BUTTON_LABELS = SEND_LABELS + FINISH_LABELS + CANCEL_LABELS
  }
}

internal object UssdAutomationStore {
  private const val PREFS = "ussd_automation"
  private const val KEYSTORE_PROVIDER = "AndroidKeyStore"
  private const val KEY_ALIAS = "ussd_automation_aes_key_v1"
  private const val CIPHER_TRANSFORMATION = "AES/GCM/NoPadding"
  private const val ENCRYPTED_PREFIX = "enc:v1:"
  private const val GCM_TAG_LENGTH_BITS = 128
  private const val GCM_IV_LENGTH_BYTES = 12
  private const val KEY_ENCRYPTION_MIGRATED = "encryption_migrated_v1"
  private const val KEY_ARMED = "armed"
  private const val KEY_STARTED = "started"
  private const val KEY_REPLIES = "replies"
  private const val KEY_INDEX = "index"
  private const val KEY_EXPIRES = "expires"
  private const val KEY_SIGNATURE = "signature"
  private const val KEY_CODE = "code"
  private const val KEY_SUBSCRIPTION = "subscription"
  private const val KEY_FLOW_NAME = "flow_name"
  private const val KEY_SAVED_FLOWS = "saved_flows"
  private const val KEY_HISTORY = "response_history"
  private const val KEY_SESSION_ID = "session_id"
  private const val KEY_AUTOMATION_SESSION_ID = "automation_session_id"
  private const val KEY_AUTOMATION_STATUS = "automation_status"
  private const val KEY_AUTOMATION_MESSAGE = "automation_message"
  private const val KEY_AUTOMATION_UPDATED = "automation_updated"
  private const val KEY_TOTAL_STEPS = "total_steps"
  private const val KEY_LAST_RESPONSE = "last_response"
  private const val KEY_AWAITING_RESPONSE = "awaiting_response"
  private const val KEY_ACTION_PENDING = "action_pending"
  private const val KEY_ACTION_SIGNATURE = "action_signature"
  private const val KEY_ACTION_STARTED = "action_started"
  private const val KEY_RECORDING = "recording"
  private const val KEY_RECORDING_STATUS = "recording_status"
  private const val KEY_RECORDING_CODE = "recording_code"
  private const val KEY_RECORDING_SUBSCRIPTION = "recording_subscription"
  private const val KEY_RECORDING_REPLIES = "recording_replies"
  private const val KEY_RECORDING_EXPIRES = "recording_expires"
  private const val KEY_RECORDING_UPDATED = "recording_updated"
  private const val KEY_RECORDING_DRAFT = "recording_draft"
  private const val KEY_RECORDING_ID = "recording_id"
  private const val AUTOMATION_STEP_TIMEOUT_MS = 120_000L
  private const val RECORDING_TIMEOUT_MS = 300_000L

  private val migrationLock = Any()
  private val stateLock = Any()

  /**
   * Keeps string values encrypted at rest while retaining the normal SharedPreferences
   * representation for booleans, integers, and longs. If the Android Keystore is
   * temporarily unavailable, reads continue to support legacy plaintext and writes
   * containing strings are abandoned as a unit instead of replacing recoverable data.
   */
  private class SecurePreferences(private val delegate: SharedPreferences) {
    init {
      migratePlaintextStrings(delegate)
    }

    fun getBoolean(key: String, defaultValue: Boolean): Boolean =
      try { delegate.getBoolean(key, defaultValue) } catch (_: ClassCastException) { defaultValue }

    fun getInt(key: String, defaultValue: Int): Int =
      try { delegate.getInt(key, defaultValue) } catch (_: ClassCastException) { defaultValue }

    fun getLong(key: String, defaultValue: Long): Long =
      try { delegate.getLong(key, defaultValue) } catch (_: ClassCastException) { defaultValue }

    fun getString(key: String, defaultValue: String?): String? {
      val stored = try {
        delegate.getString(key, null)
      } catch (_: ClassCastException) {
        null
      } ?: return defaultValue
      if (!stored.startsWith(ENCRYPTED_PREFIX)) return stored

      val decrypted = decryptString(stored)
      if (decrypted != null) return decrypted

      // Before migration succeeds, a legacy plaintext value may coincidentally use our
      // prefix. Once marked migrated, an undecryptable value is corrupted ciphertext
      // and must never be exposed to callers as application data.
      return if (delegate.getBoolean(KEY_ENCRYPTION_MIGRATED, false)) defaultValue else stored
    }

    fun edit(): SecureEditor = SecureEditor(delegate.edit())
  }

  private class SecureEditor(private val delegate: SharedPreferences.Editor) {
    private var encryptionFailed = false

    fun putBoolean(key: String, value: Boolean): SecureEditor = apply {
      delegate.putBoolean(key, value)
    }

    fun putInt(key: String, value: Int): SecureEditor = apply {
      delegate.putInt(key, value)
    }

    fun putLong(key: String, value: Long): SecureEditor = apply {
      delegate.putLong(key, value)
    }

    fun putString(key: String, value: String?): SecureEditor = apply {
      if (value == null) {
        delegate.remove(key)
        return@apply
      }
      val encrypted = encryptString(value)
      if (encrypted == null) {
        encryptionFailed = true
      } else {
        delegate.putString(key, encrypted)
      }
    }

    fun remove(key: String): SecureEditor = apply {
      delegate.remove(key)
    }

    fun apply() {
      if (!encryptionFailed) delegate.apply()
    }

    fun commit(): Boolean = !encryptionFailed && delegate.commit()
  }

  private fun preferences(context: Context): SecurePreferences =
    SecurePreferences(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE))

  private fun migratePlaintextStrings(preferences: SharedPreferences) {
    if (preferences.getBoolean(KEY_ENCRYPTION_MIGRATED, false)) return
    synchronized(migrationLock) {
      if (preferences.getBoolean(KEY_ENCRYPTION_MIGRATED, false)) return

      // Resolve the key before creating an editor. A failure therefore cannot modify
      // or remove any of the existing plaintext values.
      if (getOrCreateSecretKey() == null) return
      val encryptedValues = LinkedHashMap<String, String>()
      for ((key, rawValue) in preferences.all) {
        val value = rawValue as? String ?: continue
        if (value.startsWith(ENCRYPTED_PREFIX)) {
          // Never encrypt an existing envelope again. If authentication fails (for
          // example after a Keystore key is lost), preserve every value and retry no
          // migration writes rather than destroying the only recoverable copy.
          if (decryptString(value) == null) return
          continue
        }
        val encrypted = encryptString(value) ?: return
        encryptedValues[key] = encrypted
      }

      // SharedPreferences applies one Editor transaction atomically in memory and on
      // disk. The completion flag and every migrated string move together.
      val editor = preferences.edit()
      for ((key, value) in encryptedValues) editor.putString(key, value)
      editor.putBoolean(KEY_ENCRYPTION_MIGRATED, true)
      editor.commit()
    }
  }

  private fun getOrCreateSecretKey(): SecretKey? = try {
    val keyStore = KeyStore.getInstance(KEYSTORE_PROVIDER).apply { load(null) }
    (keyStore.getKey(KEY_ALIAS, null) as? SecretKey) ?: run {
      val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE_PROVIDER)
      val specification = KeyGenParameterSpec.Builder(
        KEY_ALIAS,
        KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
      )
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .setRandomizedEncryptionRequired(true)
        .build()
      generator.init(specification)
      generator.generateKey()
    }
  } catch (_: Exception) {
    null
  }

  private fun encryptString(plaintext: String): String? {
    return try {
      val key = getOrCreateSecretKey() ?: return null
      val cipher = Cipher.getInstance(CIPHER_TRANSFORMATION)
      cipher.init(Cipher.ENCRYPT_MODE, key)
      val iv = cipher.iv
      if (iv == null || iv.size != GCM_IV_LENGTH_BYTES) return null
      val ciphertext = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))
      ENCRYPTED_PREFIX +
        Base64.encodeToString(iv, Base64.NO_WRAP) + ":" +
        Base64.encodeToString(ciphertext, Base64.NO_WRAP)
    } catch (_: Exception) {
      null
    }
  }

  private fun decryptString(stored: String): String? {
    return try {
      if (!stored.startsWith(ENCRYPTED_PREFIX)) return null
      val payload = stored.removePrefix(ENCRYPTED_PREFIX)
      val separator = payload.indexOf(':')
      if (separator <= 0 || separator == payload.lastIndex) return null
      val iv = Base64.decode(payload.substring(0, separator), Base64.NO_WRAP)
      if (iv.size != GCM_IV_LENGTH_BYTES) return null
      val ciphertext = Base64.decode(payload.substring(separator + 1), Base64.NO_WRAP)
      val key = getOrCreateSecretKey() ?: return null
      val cipher = Cipher.getInstance(CIPHER_TRANSFORMATION)
      cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(GCM_TAG_LENGTH_BITS, iv))
      String(cipher.doFinal(ciphertext), Charsets.UTF_8)
    } catch (_: Exception) {
      null
    }
  }

  fun arm(
    context: android.content.Context,
    code: String,
    replies: List<String>,
    subscriptionId: Int,
    flowName: String
  ): Boolean = synchronized(stateLock) {
    val cleanReplies = replies.map(String::trim)
    val prefs = preferences(context)
    if (prefs.getBoolean(KEY_ARMED, false) || prefs.getBoolean(KEY_RECORDING, false)) {
      return@synchronized false
    }
    val startedAt = System.currentTimeMillis()
    val sessionId = "$startedAt-$subscriptionId"
    val sessions = readSessions(prefs)

    val previousSessionId = prefs.getString(KEY_SESSION_ID, "").orEmpty()
    if (previousSessionId.isNotEmpty()) {
      finishSessionInMemory(sessions, previousSessionId, "replaced", startedAt)
    }
    sessions.put(org.json.JSONObject()
      .put("id", sessionId)
      .put("startedAt", startedAt)
      .put("endedAt", 0L)
      .put("flowName", flowName.ifBlank { "Unsaved flow" })
      .put("code", code)
      .put("subscriptionId", subscriptionId)
      .put("status", "running")
      .put("entries", JSONArray()))

    prefs.edit()
      .putBoolean(KEY_ARMED, true)
      .putBoolean(KEY_STARTED, false)
      .putString(KEY_REPLIES, JSONArray(cleanReplies).toString())
      .putInt(KEY_INDEX, 0)
      .putInt(KEY_TOTAL_STEPS, cleanReplies.size)
      .putLong(KEY_EXPIRES, startedAt + AUTOMATION_STEP_TIMEOUT_MS)
      .putString(KEY_CODE, code)
      .putInt(KEY_SUBSCRIPTION, subscriptionId)
      .putString(KEY_FLOW_NAME, flowName.ifBlank { "Unsaved flow" })
      .putString(KEY_SESSION_ID, sessionId)
      .putString(KEY_AUTOMATION_SESSION_ID, sessionId)
      .putString(KEY_HISTORY, trimSessions(sessions).toString())
      .putString(KEY_AUTOMATION_STATUS, "running")
      .putString(KEY_AUTOMATION_MESSAGE, "Waiting for the first USSD response.")
      .putLong(KEY_AUTOMATION_UPDATED, startedAt)
      .putBoolean(KEY_AWAITING_RESPONSE, false)
      .putBoolean(KEY_ACTION_PENDING, false)
      .putBoolean(KEY_RECORDING, false)
      .putString(KEY_RECORDING_STATUS, if (prefs.getBoolean(KEY_RECORDING, false)) "interrupted" else prefs.getString(KEY_RECORDING_STATUS, "idle"))
      .remove(KEY_SIGNATURE)
      .remove(KEY_LAST_RESPONSE)
      .remove(KEY_ACTION_SIGNATURE)
      .remove(KEY_ACTION_STARTED)
      .remove(KEY_RECORDING_DRAFT)
      .commit()
  }

  fun stop(
    context: android.content.Context,
    status: String = "stopped",
    message: String = defaultAutomationMessage(status)
  ): Boolean = synchronized(stateLock) {
    val prefs = preferences(context)
    if (!prefs.getBoolean(KEY_ARMED, false)) return@synchronized true
    val saved = finishAutomationLocked(prefs, status, message, System.currentTimeMillis())
    if (!saved) emergencyDisarm(context)
    saved
  }

  fun interruptActive(context: android.content.Context, message: String) {
    if (isArmed(context)) stop(context, "interrupted", message)
    if (isRecording(context)) finishRecording(context, "interrupted")
  }

  fun interruptStalePendingAction(context: android.content.Context): Boolean = synchronized(stateLock) {
    val prefs = preferences(context)
    if (!prefs.getBoolean(KEY_ARMED, false) || !prefs.getBoolean(KEY_ACTION_PENDING, false)) return@synchronized false
    val saved = finishAutomationLocked(
      prefs,
      "interrupted",
      "A pending USSD action was interrupted before its result was known.",
      System.currentTimeMillis()
    )
    if (!saved) emergencyDisarm(context)
    true
  }

  fun reapExpiredAutomation(context: android.content.Context): Boolean = synchronized(stateLock) {
    val prefs = preferences(context)
    if (!prefs.getBoolean(KEY_ARMED, false)) return@synchronized false
    val expiresAt = prefs.getLong(KEY_EXPIRES, 0L)
    if (expiresAt > 0L && System.currentTimeMillis() <= expiresAt) return@synchronized false
    val saved = finishAutomationLocked(
      prefs,
      "timed_out",
      "No new USSD response arrived before the step timed out.",
      System.currentTimeMillis()
    )
    if (!saved) emergencyDisarm(context)
    true
  }

  fun isArmed(context: android.content.Context) =
    preferences(context).getBoolean(KEY_ARMED, false)

  fun hasActiveWork(context: android.content.Context): Boolean {
    reapExpiredAutomation(context)
    reapExpiredRecording(context)
    val prefs = preferences(context)
    return prefs.getBoolean(KEY_ARMED, false) || prefs.getBoolean(KEY_RECORDING, false)
  }

  fun hasStarted(context: android.content.Context) =
    preferences(context).getBoolean(KEY_STARTED, false)

  fun currentIndex(context: android.content.Context) =
    preferences(context).getInt(KEY_INDEX, 0)

  fun lastSignature(context: android.content.Context): String? =
    preferences(context).getString(KEY_SIGNATURE, null)

  fun nextReply(context: android.content.Context): String? {
    val prefs = preferences(context)
    val replies = safeJsonArray(prefs.getString(KEY_REPLIES, "[]"))
    val index = prefs.getInt(KEY_INDEX, 0)
    return if (index < replies.length()) replies.optString(index) else null
  }

  fun isFreshResponse(context: android.content.Context, fingerprint: String): Boolean {
    val prefs = preferences(context)
    return !prefs.getBoolean(KEY_AWAITING_RESPONSE, false) ||
      prefs.getString(KEY_LAST_RESPONSE, null) != fingerprint
  }

  fun beginPendingAction(context: android.content.Context, signature: String): Boolean = synchronized(stateLock) {
    val prefs = preferences(context)
    if (!prefs.getBoolean(KEY_ARMED, false)) return@synchronized false
    prefs.edit()
      .putBoolean(KEY_ACTION_PENDING, true)
      .putString(KEY_ACTION_SIGNATURE, signature)
      .putLong(KEY_ACTION_STARTED, System.currentTimeMillis())
      .commit()
  }

  fun completeSuccessfulAction(
    context: android.content.Context,
    signature: String,
    response: String,
    reply: String,
    cancel: Boolean
  ): Boolean = synchronized(stateLock) {
    val prefs = preferences(context)
    if (!prefs.getBoolean(KEY_ARMED, false) ||
      !prefs.getBoolean(KEY_ACTION_PENDING, false) ||
      prefs.getString(KEY_ACTION_SIGNATURE, "") != signature
    ) return@synchronized false

    val now = System.currentTimeMillis()
    val sessions = readSessions(prefs)
    val sessionId = prefs.getString(KEY_SESSION_ID, "").orEmpty()
    val currentStep = prefs.getInt(KEY_INDEX, 0)
    appendHistoryEntry(sessions, sessionId, now, currentStep, reply, response, if (cancel) "cancel" else "reply")

    if (cancel) {
      finishSessionInMemory(sessions, sessionId, "cancelled", now)
      return@synchronized prefs.edit()
        .putString(KEY_HISTORY, sessions.toString())
        .putBoolean(KEY_ARMED, false)
        .putBoolean(KEY_ACTION_PENDING, false)
        .putBoolean(KEY_AWAITING_RESPONSE, false)
        .putString(KEY_AUTOMATION_STATUS, "cancelled")
        .putString(KEY_AUTOMATION_MESSAGE, "USSD session was cancelled by the saved flow.")
        .putLong(KEY_AUTOMATION_UPDATED, now)
        .remove(KEY_ACTION_SIGNATURE)
        .remove(KEY_ACTION_STARTED)
        .remove(KEY_SESSION_ID)
        .commit()
    }

    val nextStep = currentStep + 1
    val totalSteps = prefs.getInt(KEY_TOTAL_STEPS, 0)
    val waitMessage = if (nextStep >= totalSteps) {
      "Waiting for the final USSD response."
    } else {
      "Waiting for response before step ${nextStep + 1} of $totalSteps."
    }
    prefs.edit()
      .putString(KEY_HISTORY, sessions.toString())
      .putBoolean(KEY_STARTED, true)
      .putInt(KEY_INDEX, nextStep)
      .putString(KEY_SIGNATURE, signature)
      .putString(KEY_LAST_RESPONSE, signature.substringAfter('|'))
      .putBoolean(KEY_AWAITING_RESPONSE, true)
      .putBoolean(KEY_ACTION_PENDING, false)
      .putLong(KEY_EXPIRES, now + AUTOMATION_STEP_TIMEOUT_MS)
      .putString(KEY_AUTOMATION_STATUS, "running")
      .putString(KEY_AUTOMATION_MESSAGE, waitMessage)
      .putLong(KEY_AUTOMATION_UPDATED, now)
      .remove(KEY_ACTION_SIGNATURE)
      .remove(KEY_ACTION_STARTED)
      .commit()
  }

  fun failPendingAction(context: android.content.Context, status: String, message: String): Boolean =
    stop(context, status, message)

  fun finishWithResponse(
    context: android.content.Context,
    status: String,
    message: String,
    response: String,
    action: String
  ): Boolean = synchronized(stateLock) {
    val prefs = preferences(context)
    if (!prefs.getBoolean(KEY_ARMED, false)) return@synchronized false
    val now = System.currentTimeMillis()
    val sessions = readSessions(prefs)
    val sessionId = prefs.getString(KEY_SESSION_ID, "").orEmpty()
    appendHistoryEntry(sessions, sessionId, now, prefs.getInt(KEY_INDEX, 0), "", response, action)
    finishSessionInMemory(sessions, sessionId, status, now)
    val saved = prefs.edit()
      .putString(KEY_HISTORY, sessions.toString())
      .putBoolean(KEY_ARMED, false)
      .putBoolean(KEY_ACTION_PENDING, false)
      .putBoolean(KEY_AWAITING_RESPONSE, false)
      .putString(KEY_AUTOMATION_STATUS, status)
      .putString(KEY_AUTOMATION_MESSAGE, message)
      .putLong(KEY_AUTOMATION_UPDATED, now)
      .remove(KEY_ACTION_SIGNATURE)
      .remove(KEY_ACTION_STARTED)
      .remove(KEY_SESSION_ID)
      .commit()
    if (!saved) emergencyDisarm(context)
    saved
  }

  fun emergencyDisarm(context: android.content.Context) {
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
      .putBoolean(KEY_ARMED, false)
      .putBoolean(KEY_ACTION_PENDING, true)
      .commit()
  }

  fun getAutomationStatus(context: android.content.Context): Map<String, Any> {
    reapExpiredAutomation(context)
    val prefs = preferences(context)
    val interruptedPending = !prefs.getBoolean(KEY_ARMED, false) && prefs.getBoolean(KEY_ACTION_PENDING, false)
    return mapOf(
      "status" to if (interruptedPending) "interrupted_pending" else prefs.getString(KEY_AUTOMATION_STATUS, "idle").orEmpty(),
      "message" to if (interruptedPending) {
        "A USSD action was interrupted and its result could not be confirmed. Check before retrying."
      } else prefs.getString(KEY_AUTOMATION_MESSAGE, "").orEmpty(),
      "sessionId" to prefs.getString(
        KEY_AUTOMATION_SESSION_ID,
        prefs.getString(KEY_SESSION_ID, "").orEmpty()
      ).orEmpty(),
      "flowName" to prefs.getString(KEY_FLOW_NAME, "").orEmpty(),
      "code" to prefs.getString(KEY_CODE, "").orEmpty(),
      "subscriptionId" to prefs.getInt(KEY_SUBSCRIPTION, -1),
      "currentStep" to prefs.getInt(KEY_INDEX, 0),
      "totalSteps" to prefs.getInt(KEY_TOTAL_STEPS, 0),
      "updatedAt" to prefs.getLong(KEY_AUTOMATION_UPDATED, 0L)
    )
  }

  fun acknowledgeAutomation(context: android.content.Context, updatedAt: Long): Boolean = synchronized(stateLock) {
    val prefs = preferences(context)
    if (prefs.getBoolean(KEY_ARMED, false) || prefs.getLong(KEY_AUTOMATION_UPDATED, 0L) != updatedAt) {
      return@synchronized false
    }
    prefs.edit().putString(KEY_AUTOMATION_STATUS, "reviewed").commit()
  }

  fun saveFlow(
    context: android.content.Context,
    name: String,
    code: String,
    replies: List<String>,
    subscriptionId: Int
  ): Boolean = synchronized(stateLock) {
    val prefs = preferences(context)
    val flows = safeJsonArray(prefs.getString(KEY_SAVED_FLOWS, "[]"))
    val cleanName = name.trim()
    val existingIndex = (0 until flows.length()).firstOrNull {
      flows.optJSONObject(it)?.optString("name")?.equals(cleanName, ignoreCase = true) == true
    }
    val id = existingIndex?.let { flows.optJSONObject(it)?.optString("id") }
      ?: System.currentTimeMillis().toString()
    val flow = org.json.JSONObject()
      .put("id", id)
      .put("name", cleanName)
      .put("code", code)
      .put("replies", JSONArray(replies.map(String::trim).filter(String::isNotEmpty)))
      .put("subscriptionId", subscriptionId)
      .put("updatedAt", System.currentTimeMillis())
    if (existingIndex == null) flows.put(flow) else flows.put(existingIndex, flow)
    prefs.edit().putString(KEY_SAVED_FLOWS, flows.toString()).commit()
  }

  fun deleteFlow(context: android.content.Context, id: String): Boolean = synchronized(stateLock) {
    val prefs = preferences(context)
    val source = safeJsonArray(prefs.getString(KEY_SAVED_FLOWS, "[]"))
    val result = JSONArray()
    for (index in 0 until source.length()) {
      source.optJSONObject(index)?.takeIf { it.optString("id") != id }?.let(result::put)
    }
    prefs.edit().putString(KEY_SAVED_FLOWS, result.toString()).commit()
  }

  fun getSavedFlows(context: android.content.Context): List<Map<String, Any>> {
    val prefs = preferences(context)
    val flows = safeJsonArray(prefs.getString(KEY_SAVED_FLOWS, "[]"))
    return (0 until flows.length()).mapNotNull { index ->
      flows.optJSONObject(index)?.let { flow ->
        val replies = flow.optJSONArray("replies") ?: JSONArray()
        mapOf(
          "id" to flow.optString("id"),
          "name" to flow.optString("name"),
          "code" to flow.optString("code"),
          "replies" to (0 until replies.length()).map(replies::optString),
          "subscriptionId" to flow.optInt("subscriptionId"),
          "updatedAt" to flow.optLong("updatedAt")
        )
      }
    }.sortedByDescending { (it["updatedAt"] as? Long) ?: 0L }
  }

  fun getResponseHistory(context: android.content.Context): List<Map<String, Any>> {
    reapExpiredAutomation(context)
    val prefs = preferences(context)
    val sessions = readSessions(prefs)
    return (sessions.length() - 1 downTo 0).mapNotNull { index ->
      sessions.optJSONObject(index)?.let { session ->
        val entries = session.optJSONArray("entries") ?: JSONArray()
        mapOf(
          "id" to session.optString("id"),
          "startedAt" to session.optLong("startedAt"),
          "endedAt" to session.optLong("endedAt"),
          "flowName" to session.optString("flowName"),
          "code" to session.optString("code"),
          "subscriptionId" to session.optInt("subscriptionId"),
          "status" to session.optString("status", "completed"),
          "entries" to (0 until entries.length()).mapNotNull { entryIndex ->
            entries.optJSONObject(entryIndex)?.let { entry ->
              mapOf(
                "timestamp" to entry.optLong("timestamp"),
                "stepIndex" to entry.optInt("stepIndex"),
                "reply" to entry.optString("reply"),
                "response" to entry.optString("response"),
                "action" to entry.optString("action")
              )
            }
          }
        )
      }
    }
  }

  private fun readSessions(prefs: SecurePreferences): JSONArray {
    val stored = safeJsonArray(prefs.getString(KEY_HISTORY, "[]"))
    if (stored.length() == 0 || stored.optJSONObject(0)?.has("entries") == true) return stored
    val migrated = JSONArray()
    for (index in 0 until stored.length()) {
      val old = stored.optJSONObject(index) ?: continue
      val entry = org.json.JSONObject()
        .put("timestamp", old.optLong("timestamp"))
        .put("stepIndex", old.optInt("stepIndex"))
        .put("reply", old.optString("reply"))
        .put("response", old.optString("response"))
        .put("action", old.optString("action"))
      migrated.put(org.json.JSONObject()
        .put("id", old.optString("id"))
        .put("startedAt", old.optLong("timestamp"))
        .put("endedAt", old.optLong("timestamp"))
        .put("flowName", old.optString("flowName"))
        .put("code", old.optString("code"))
        .put("subscriptionId", old.optInt("subscriptionId"))
        .put("status", "completed")
        .put("entries", JSONArray().put(entry)))
    }
    return migrated
  }

  private fun finishSessionInMemory(sessions: JSONArray, sessionId: String, status: String, endedAt: Long) {
    if (sessionId.isEmpty()) return
    for (index in 0 until sessions.length()) {
      val session = sessions.optJSONObject(index) ?: continue
      if (session.optString("id") == sessionId && session.optString("status") == "running") {
        session.put("status", status).put("endedAt", endedAt)
        break
      }
    }
  }

  private fun appendHistoryEntry(
    sessions: JSONArray,
    sessionId: String,
    timestamp: Long,
    stepIndex: Int,
    reply: String,
    response: String,
    action: String
  ) {
    if (response.isBlank() || sessionId.isBlank()) return
    val session = (0 until sessions.length())
      .mapNotNull(sessions::optJSONObject)
      .firstOrNull { it.optString("id") == sessionId } ?: return
    val entries = session.optJSONArray("entries") ?: JSONArray().also { session.put("entries", it) }
    entries.put(org.json.JSONObject()
      .put("timestamp", timestamp)
      .put("stepIndex", stepIndex)
      .put("reply", reply)
      .put("response", response.replace('|', '\n'))
      .put("action", action))
  }

  private fun finishAutomationLocked(
    prefs: SecurePreferences,
    status: String,
    message: String,
    endedAt: Long
  ): Boolean {
    val sessionId = prefs.getString(KEY_SESSION_ID, "").orEmpty()
    val sessions = readSessions(prefs)
    finishSessionInMemory(sessions, sessionId, status, endedAt)
    val editor = prefs.edit()
      .putBoolean(KEY_ARMED, false)
      .putBoolean(KEY_ACTION_PENDING, false)
      .putBoolean(KEY_AWAITING_RESPONSE, false)
      .putString(KEY_AUTOMATION_STATUS, status)
      .putString(KEY_AUTOMATION_MESSAGE, message)
      .putLong(KEY_AUTOMATION_UPDATED, endedAt)
      .remove(KEY_ACTION_SIGNATURE)
      .remove(KEY_ACTION_STARTED)
      .remove(KEY_SESSION_ID)
    if (sessionId.isNotEmpty()) editor.putString(KEY_HISTORY, sessions.toString())
    return editor.commit()
  }

  private fun defaultAutomationMessage(status: String): String = when (status) {
    "completed" -> "USSD flow completed."
    "cancelled" -> "USSD flow was cancelled."
    "timed_out" -> "No new USSD response arrived before the step timed out."
    "interrupted" -> "USSD flow was interrupted."
    "failed_to_start" -> "The phone could not start the USSD session."
    else -> "USSD flow stopped."
  }

  private fun safeJsonArray(value: String?): JSONArray = try {
    JSONArray(value ?: "[]")
  } catch (_: Exception) {
    JSONArray()
  }

  private fun trimSessions(sessions: JSONArray): JSONArray {
    val trimmed = JSONArray()
    val start = (sessions.length() - 50).coerceAtLeast(0)
    for (index in start until sessions.length()) sessions.opt(index)?.let(trimmed::put)
    return trimmed
  }

  fun clearResponseHistory(context: android.content.Context): Boolean = synchronized(stateLock) {
    val prefs = preferences(context)
    if (prefs.getBoolean(KEY_ARMED, false) || prefs.getBoolean(KEY_RECORDING, false)) return@synchronized false
    prefs.edit().remove(KEY_HISTORY).remove(KEY_SESSION_ID).commit()
  }

  fun startRecording(context: android.content.Context, code: String, subscriptionId: Int): Boolean = synchronized(stateLock) {
    val prefs = preferences(context)
    if (prefs.getBoolean(KEY_ARMED, false) || prefs.getBoolean(KEY_RECORDING, false)) {
      return@synchronized false
    }
    val now = System.currentTimeMillis()
    val sessions = readSessions(prefs)
    val sessionId = prefs.getString(KEY_SESSION_ID, "").orEmpty()
    if (sessionId.isNotEmpty()) finishSessionInMemory(sessions, sessionId, "replaced", now)
    prefs.edit()
      .putBoolean(KEY_ARMED, false)
      .putBoolean(KEY_ACTION_PENDING, false)
      .putBoolean(KEY_AWAITING_RESPONSE, false)
      .putString(KEY_AUTOMATION_STATUS, if (sessionId.isNotEmpty()) "interrupted" else prefs.getString(KEY_AUTOMATION_STATUS, "idle"))
      .putString(KEY_AUTOMATION_MESSAGE, if (sessionId.isNotEmpty()) "Automation was replaced by a recording." else prefs.getString(KEY_AUTOMATION_MESSAGE, ""))
      .putLong(KEY_AUTOMATION_UPDATED, if (sessionId.isNotEmpty()) now else prefs.getLong(KEY_AUTOMATION_UPDATED, 0L))
      .putString(KEY_HISTORY, sessions.toString())
      .putBoolean(KEY_RECORDING, true)
      .putString(KEY_RECORDING_STATUS, "recording")
      .putString(KEY_RECORDING_CODE, code)
      .putInt(KEY_RECORDING_SUBSCRIPTION, subscriptionId)
      .putString(KEY_RECORDING_REPLIES, "[]")
      .putLong(KEY_RECORDING_EXPIRES, now + RECORDING_TIMEOUT_MS)
      .putLong(KEY_RECORDING_UPDATED, now)
      .putLong(KEY_RECORDING_ID, now)
      .remove(KEY_SESSION_ID)
      .remove(KEY_ACTION_SIGNATURE)
      .remove(KEY_ACTION_STARTED)
      .remove(KEY_RECORDING_DRAFT)
      .commit()
  }

  fun isRecording(context: android.content.Context) =
    preferences(context).getBoolean(KEY_RECORDING, false)

  fun isRecordingExpired(context: android.content.Context): Boolean {
    val prefs = preferences(context)
    return System.currentTimeMillis() > prefs.getLong(KEY_RECORDING_EXPIRES, 0L)
  }

  fun reapExpiredRecording(context: android.content.Context): Boolean = synchronized(stateLock) {
    val prefs = preferences(context)
    if (!prefs.getBoolean(KEY_RECORDING, false)) return@synchronized false
    if (System.currentTimeMillis() <= prefs.getLong(KEY_RECORDING_EXPIRES, 0L)) return@synchronized false
    if (!finishRecordingLocked(prefs, "timed_out", System.currentTimeMillis())) {
      context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
        .putBoolean(KEY_RECORDING, false)
        .commit()
    }
    true
  }

  fun recordingId(context: android.content.Context): Long =
    preferences(context).getLong(KEY_RECORDING_ID, 0L)

  fun recordManualReply(context: android.content.Context, reply: String): Boolean = synchronized(stateLock) {
    val prefs = preferences(context)
    if (!prefs.getBoolean(KEY_RECORDING, false)) return@synchronized false
    val replies = safeJsonArray(prefs.getString(KEY_RECORDING_REPLIES, "[]"))
    val now = System.currentTimeMillis()
    val lastReply = if (replies.length() > 0) replies.optString(replies.length() - 1) else ""
    val lastUpdated = prefs.getLong(KEY_RECORDING_UPDATED, 0L)
    if (lastReply == reply && now - lastUpdated < 800L) return@synchronized false
    replies.put(reply)
    return@synchronized prefs.edit()
      .putString(KEY_RECORDING_REPLIES, replies.toString())
      .putLong(KEY_RECORDING_UPDATED, now)
      .remove(KEY_RECORDING_DRAFT)
      .commit()
  }

  fun finishRecording(context: android.content.Context, status: String): Boolean = synchronized(stateLock) {
    val prefs = preferences(context)
    if (!prefs.getBoolean(KEY_RECORDING, false) && prefs.getString(KEY_RECORDING_STATUS, "idle") != "recording") {
      return@synchronized true
    }
    val saved = finishRecordingLocked(prefs, status, System.currentTimeMillis())
    if (!saved) {
      context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
        .putBoolean(KEY_RECORDING, false)
        .commit()
    }
    saved
  }

  private fun finishRecordingLocked(prefs: SecurePreferences, status: String, now: Long): Boolean =
    prefs.edit()
      .putBoolean(KEY_RECORDING, false)
      .putString(KEY_RECORDING_STATUS, status)
      .putLong(KEY_RECORDING_UPDATED, now)
      .remove(KEY_RECORDING_DRAFT)
      .commit()

  fun saveRecordingDraft(context: android.content.Context, draft: String) {
    preferences(context).edit()
      .putString(KEY_RECORDING_DRAFT, draft)
      .apply()
  }

  fun recordingDraft(context: android.content.Context): String =
    preferences(context)
      .getString(KEY_RECORDING_DRAFT, "").orEmpty()

  fun getRecording(context: android.content.Context): Map<String, Any> {
    reapExpiredRecording(context)
    val prefs = preferences(context)
    val replies = safeJsonArray(prefs.getString(KEY_RECORDING_REPLIES, "[]"))
    val storedStatus = prefs.getString(KEY_RECORDING_STATUS, "idle").orEmpty()
    val status = if (!prefs.getBoolean(KEY_RECORDING, false) && storedStatus == "recording") {
      "interrupted"
    } else storedStatus
    return mapOf(
      "status" to status,
      "code" to prefs.getString(KEY_RECORDING_CODE, "").orEmpty(),
      "subscriptionId" to prefs.getInt(KEY_RECORDING_SUBSCRIPTION, -1),
      "replies" to (0 until replies.length()).map(replies::optString),
      "updatedAt" to prefs.getLong(KEY_RECORDING_UPDATED, 0L)
    )
  }

  fun acknowledgeRecording(context: android.content.Context, updatedAt: Long): Boolean = synchronized(stateLock) {
    val prefs = preferences(context)
    if (prefs.getBoolean(KEY_RECORDING, false) || prefs.getLong(KEY_RECORDING_UPDATED, 0L) != updatedAt) {
      return@synchronized false
    }
    if (prefs.getString(KEY_RECORDING_STATUS, "idle") == "reviewed") return@synchronized true
    prefs.edit().putString(KEY_RECORDING_STATUS, "reviewed").commit()
  }

  fun clearPendingRecording(context: android.content.Context): Boolean = synchronized(stateLock) {
    val prefs = preferences(context)
    if (prefs.getBoolean(KEY_RECORDING, false)) return@synchronized false
    prefs.edit()
      .putString(KEY_RECORDING_STATUS, "idle")
      .remove(KEY_RECORDING_CODE)
      .remove(KEY_RECORDING_SUBSCRIPTION)
      .remove(KEY_RECORDING_REPLIES)
      .remove(KEY_RECORDING_UPDATED)
      .remove(KEY_RECORDING_DRAFT)
      .remove(KEY_RECORDING_ID)
      .commit()
  }
}
