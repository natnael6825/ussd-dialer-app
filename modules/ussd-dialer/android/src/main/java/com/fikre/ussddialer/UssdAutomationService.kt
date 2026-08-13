package com.fikre.ussddialer

import android.accessibilityservice.AccessibilityService
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.Toast
import org.json.JSONArray

class UssdAutomationService : AccessibilityService() {
  private val handler = Handler(Looper.getMainLooper())
  private var pendingSignature: String? = null
  private var recordingDraft: String = ""
  private var recordingMenuSignature: String = ""

  override fun onAccessibilityEvent(event: AccessibilityEvent?) {
    val packageName = event?.packageName?.toString().orEmpty()
    if (packageName !in ALLOWED_PACKAGES) return
    if (UssdAutomationStore.isRecording(this)) {
      handleRecordingEvent(event ?: return)
      return
    }
    if (!UssdAutomationStore.isArmed(this)) return
    if (UssdAutomationStore.isExpired(this)) {
      UssdAutomationStore.stop(this, "timed_out")
      Toast.makeText(this, "USSD Flow timed out", Toast.LENGTH_SHORT).show()
      return
    }

    val root = rootInActiveWindow ?: return
    val reply = UssdAutomationStore.nextReply(this) ?: run {
      UssdAutomationStore.stop(this, "completed")
      return
    }
    val responseText = collectText(root)
      .filterNot { it.lowercase() in ALL_BUTTON_LABELS }
      .joinToString("|")
    val signature = "$packageName|$responseText|${UssdAutomationStore.currentIndex(this)}"
    if (signature == UssdAutomationStore.lastSignature(this) || signature == pendingSignature) return

    if (reply.equals(CANCEL_COMMAND, ignoreCase = true)) {
      val cancelButton = findFirst(root) { node ->
        node.isClickable && node.isVisibleToUser && nodeLabel(node) in CANCEL_LABELS
      } ?: return

      pendingSignature = signature
      UssdAutomationStore.recordResponse(this, responseText, reply, "cancel")
      handler.postDelayed({
        if (!UssdAutomationStore.isArmed(this) || pendingSignature != signature) return@postDelayed
        val liveRoot = rootInActiveWindow ?: return@postDelayed
        val liveCancel = findFirst(liveRoot) { node ->
          node.isClickable && node.isVisibleToUser && nodeLabel(node) in CANCEL_LABELS
        } ?: return@postDelayed
        if (liveCancel.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
          UssdAutomationStore.stop(this, "cancelled")
          Toast.makeText(this, "USSD Flow cancelled the session", Toast.LENGTH_SHORT).show()
        }
        pendingSignature = null
      }, REPLY_DELAY_MS)
      return
    }

    val editable = findFirst(root) { it.isEditable && it.isVisibleToUser }
    val sendButton = findFirst(root) { node ->
      node.isClickable && node.isVisibleToUser && nodeLabel(node) in SEND_LABELS
    }

    if (editable == null || sendButton == null) {
      val finishButton = findFirst(root) { node ->
        node.isClickable && node.isVisibleToUser && nodeLabel(node) in FINISH_LABELS
      }
      if (finishButton != null && UssdAutomationStore.hasStarted(this)) {
        UssdAutomationStore.stop(this, "completed")
      }
      return
    }

    pendingSignature = signature
    UssdAutomationStore.recordResponse(this, responseText, reply, "reply")
    handler.postDelayed({
      if (!UssdAutomationStore.isArmed(this) || pendingSignature != signature) return@postDelayed
      val liveRoot = rootInActiveWindow ?: return@postDelayed
      val liveInput = findFirst(liveRoot) { it.isEditable && it.isVisibleToUser } ?: return@postDelayed
      val liveSend = findFirst(liveRoot) { node ->
        node.isClickable && node.isVisibleToUser && nodeLabel(node) in SEND_LABELS
      } ?: return@postDelayed
      val arguments = Bundle().apply {
        putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, reply)
      }
      val entered = liveInput.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments)
      if (entered && liveSend.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
        UssdAutomationStore.markReplySent(this, signature)
        Toast.makeText(this, "USSD Flow sent step ${UssdAutomationStore.currentIndex(this)}", Toast.LENGTH_SHORT).show()
      }
      pendingSignature = null
    }, REPLY_DELAY_MS)
  }

  override fun onInterrupt() {
    pendingSignature = null
  }

  private fun handleRecordingEvent(event: AccessibilityEvent) {
    if (UssdAutomationStore.isRecordingExpired(this)) {
      UssdAutomationStore.finishRecording(this, "timed_out")
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
      Toast.makeText(this, "USSD recording complete", Toast.LENGTH_SHORT).show()
    }
  }

  private fun commitRecordingDraft() {
    val reply = recordingDraft.ifEmpty { UssdAutomationStore.recordingDraft(this) }
    if (reply.isNotEmpty() && UssdAutomationStore.recordManualReply(this, reply)) {
      Toast.makeText(this, "Recorded reply $reply", Toast.LENGTH_SHORT).show()
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

  companion object {
    private const val REPLY_DELAY_MS = 1200L
    private const val CANCEL_COMMAND = "CANCEL"
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
  private const val KEY_RECORDING = "recording"
  private const val KEY_RECORDING_STATUS = "recording_status"
  private const val KEY_RECORDING_CODE = "recording_code"
  private const val KEY_RECORDING_SUBSCRIPTION = "recording_subscription"
  private const val KEY_RECORDING_REPLIES = "recording_replies"
  private const val KEY_RECORDING_EXPIRES = "recording_expires"
  private const val KEY_RECORDING_UPDATED = "recording_updated"
  private const val KEY_RECORDING_DRAFT = "recording_draft"

  fun arm(
    context: android.content.Context,
    code: String,
    replies: List<String>,
    subscriptionId: Int,
    flowName: String
  ) {
    val cleanReplies = replies.map { it.trim() }.filter { it.isNotEmpty() }
    val prefs = context.getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE)
    val startedAt = System.currentTimeMillis()
    val sessionId = "$startedAt-${subscriptionId}"
    val sessions = readSessions(prefs)
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
      .putLong(KEY_EXPIRES, System.currentTimeMillis() + 120_000L)
      .putString(KEY_CODE, code)
      .putInt(KEY_SUBSCRIPTION, subscriptionId)
      .putString(KEY_FLOW_NAME, flowName.ifBlank { "Unsaved flow" })
      .putString(KEY_SESSION_ID, sessionId)
      .putString(KEY_HISTORY, trimSessions(sessions).toString())
      .remove(KEY_SIGNATURE)
      .apply()
  }

  fun stop(context: android.content.Context, status: String = "stopped") {
    val prefs = context.getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE)
    finishSession(prefs, status)
    prefs.edit()
      .putBoolean(KEY_ARMED, false)
      .apply()
  }

  fun isArmed(context: android.content.Context) =
    context.getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE).getBoolean(KEY_ARMED, false)

  fun hasStarted(context: android.content.Context) =
    context.getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE).getBoolean(KEY_STARTED, false)

  fun isExpired(context: android.content.Context) =
    System.currentTimeMillis() > context.getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE)
      .getLong(KEY_EXPIRES, 0L)

  fun currentIndex(context: android.content.Context) =
    context.getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE).getInt(KEY_INDEX, 0)

  fun lastSignature(context: android.content.Context): String? =
    context.getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE).getString(KEY_SIGNATURE, null)

  fun nextReply(context: android.content.Context): String? {
    val prefs = context.getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE)
    val replies = JSONArray(prefs.getString(KEY_REPLIES, "[]"))
    val index = prefs.getInt(KEY_INDEX, 0)
    return if (index < replies.length()) replies.optString(index) else null
  }

  fun markReplySent(context: android.content.Context, signature: String) {
    val prefs = context.getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE)
    prefs.edit()
      .putBoolean(KEY_STARTED, true)
      .putInt(KEY_INDEX, prefs.getInt(KEY_INDEX, 0) + 1)
      .putString(KEY_SIGNATURE, signature)
      .apply()
  }

  fun saveFlow(
    context: android.content.Context,
    name: String,
    code: String,
    replies: List<String>,
    subscriptionId: Int
  ) {
    val prefs = context.getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE)
    val flows = JSONArray(prefs.getString(KEY_SAVED_FLOWS, "[]"))
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
    prefs.edit().putString(KEY_SAVED_FLOWS, flows.toString()).apply()
  }

  fun deleteFlow(context: android.content.Context, id: String) {
    val prefs = context.getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE)
    val source = JSONArray(prefs.getString(KEY_SAVED_FLOWS, "[]"))
    val result = JSONArray()
    for (index in 0 until source.length()) {
      source.optJSONObject(index)?.takeIf { it.optString("id") != id }?.let(result::put)
    }
    prefs.edit().putString(KEY_SAVED_FLOWS, result.toString()).apply()
  }

  fun getSavedFlows(context: android.content.Context): List<Map<String, Any>> {
    val prefs = context.getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE)
    val flows = JSONArray(prefs.getString(KEY_SAVED_FLOWS, "[]"))
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

  fun recordResponse(context: android.content.Context, response: String, reply: String, action: String) {
    if (response.isBlank()) return
    val prefs = context.getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE)
    val sessions = readSessions(prefs)
    val sessionId = prefs.getString(KEY_SESSION_ID, "").orEmpty()
    val session = (0 until sessions.length())
      .mapNotNull(sessions::optJSONObject)
      .firstOrNull { it.optString("id") == sessionId } ?: return
    val entries = session.optJSONArray("entries") ?: JSONArray().also { session.put("entries", it) }
    val timestamp = System.currentTimeMillis()
    entries.put(org.json.JSONObject()
      .put("timestamp", timestamp)
      .put("stepIndex", currentIndex(context))
      .put("reply", reply)
      .put("response", response.replace('|', '\n'))
      .put("action", action))
    prefs.edit().putString(KEY_HISTORY, sessions.toString()).apply()
  }

  fun getResponseHistory(context: android.content.Context): List<Map<String, Any>> {
    val prefs = context.getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE)
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

  private fun readSessions(prefs: android.content.SharedPreferences): JSONArray {
    val stored = JSONArray(prefs.getString(KEY_HISTORY, "[]"))
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

  private fun finishSession(prefs: android.content.SharedPreferences, status: String) {
    val sessionId = prefs.getString(KEY_SESSION_ID, "").orEmpty()
    if (sessionId.isEmpty()) return
    val sessions = readSessions(prefs)
    for (index in 0 until sessions.length()) {
      val session = sessions.optJSONObject(index) ?: continue
      if (session.optString("id") == sessionId && session.optString("status") == "running") {
        session.put("status", status).put("endedAt", System.currentTimeMillis())
        break
      }
    }
    prefs.edit().putString(KEY_HISTORY, sessions.toString()).remove(KEY_SESSION_ID).apply()
  }

  private fun trimSessions(sessions: JSONArray): JSONArray {
    val trimmed = JSONArray()
    val start = (sessions.length() - 50).coerceAtLeast(0)
    for (index in start until sessions.length()) trimmed.put(sessions.get(index))
    return trimmed
  }

  fun clearResponseHistory(context: android.content.Context) {
    context.getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE)
      .edit().remove(KEY_HISTORY).apply()
  }

  fun startRecording(context: android.content.Context, code: String, subscriptionId: Int) {
    context.getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE).edit()
      .putBoolean(KEY_ARMED, false)
      .putBoolean(KEY_RECORDING, true)
      .putString(KEY_RECORDING_STATUS, "recording")
      .putString(KEY_RECORDING_CODE, code)
      .putInt(KEY_RECORDING_SUBSCRIPTION, subscriptionId)
      .putString(KEY_RECORDING_REPLIES, "[]")
      .putLong(KEY_RECORDING_EXPIRES, System.currentTimeMillis() + 300_000L)
      .putLong(KEY_RECORDING_UPDATED, System.currentTimeMillis())
      .remove(KEY_RECORDING_DRAFT)
      .apply()
  }

  fun isRecording(context: android.content.Context) =
    context.getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE).getBoolean(KEY_RECORDING, false)

  fun isRecordingExpired(context: android.content.Context): Boolean {
    val prefs = context.getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE)
    return System.currentTimeMillis() > prefs.getLong(KEY_RECORDING_EXPIRES, 0L)
  }

  fun recordManualReply(context: android.content.Context, reply: String): Boolean {
    val prefs = context.getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE)
    if (!prefs.getBoolean(KEY_RECORDING, false)) return false
    val replies = JSONArray(prefs.getString(KEY_RECORDING_REPLIES, "[]"))
    val now = System.currentTimeMillis()
    val lastReply = if (replies.length() > 0) replies.optString(replies.length() - 1) else ""
    val lastUpdated = prefs.getLong(KEY_RECORDING_UPDATED, 0L)
    if (lastReply == reply && now - lastUpdated < 800L) return false
    replies.put(reply)
    prefs.edit()
      .putString(KEY_RECORDING_REPLIES, replies.toString())
      .putLong(KEY_RECORDING_UPDATED, now)
      .remove(KEY_RECORDING_DRAFT)
      .apply()
    return true
  }

  fun finishRecording(context: android.content.Context, status: String) {
    val prefs = context.getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE)
    if (!prefs.getBoolean(KEY_RECORDING, false) && prefs.getString(KEY_RECORDING_STATUS, "idle") != "recording") return
    prefs.edit()
      .putBoolean(KEY_RECORDING, false)
      .putString(KEY_RECORDING_STATUS, status)
      .putLong(KEY_RECORDING_UPDATED, System.currentTimeMillis())
      .apply()
  }

  fun saveRecordingDraft(context: android.content.Context, draft: String) {
    context.getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE).edit()
      .putString(KEY_RECORDING_DRAFT, draft)
      .apply()
  }

  fun recordingDraft(context: android.content.Context): String =
    context.getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE)
      .getString(KEY_RECORDING_DRAFT, "").orEmpty()

  fun getRecording(context: android.content.Context): Map<String, Any> {
    val prefs = context.getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE)
    val replies = JSONArray(prefs.getString(KEY_RECORDING_REPLIES, "[]"))
    return mapOf(
      "status" to prefs.getString(KEY_RECORDING_STATUS, "idle").orEmpty(),
      "code" to prefs.getString(KEY_RECORDING_CODE, "").orEmpty(),
      "subscriptionId" to prefs.getInt(KEY_RECORDING_SUBSCRIPTION, -1),
      "replies" to (0 until replies.length()).map(replies::optString),
      "updatedAt" to prefs.getLong(KEY_RECORDING_UPDATED, 0L)
    )
  }

  fun acknowledgeRecording(context: android.content.Context, updatedAt: Long) {
    val prefs = context.getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE)
    if (
      !prefs.getBoolean(KEY_RECORDING, false) &&
      prefs.getLong(KEY_RECORDING_UPDATED, 0L) == updatedAt
    ) {
      prefs.edit().putString(KEY_RECORDING_STATUS, "reviewed").apply()
    }
  }

  fun clearPendingRecording(context: android.content.Context) {
    val prefs = context.getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE)
    if (prefs.getBoolean(KEY_RECORDING, false)) return
    prefs.edit()
      .putString(KEY_RECORDING_STATUS, "idle")
      .remove(KEY_RECORDING_CODE)
      .remove(KEY_RECORDING_SUBSCRIPTION)
      .remove(KEY_RECORDING_REPLIES)
      .remove(KEY_RECORDING_UPDATED)
      .remove(KEY_RECORDING_DRAFT)
      .apply()
  }
}
