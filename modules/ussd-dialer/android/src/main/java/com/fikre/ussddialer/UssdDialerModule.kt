package com.fikre.ussddialer

import android.Manifest
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.telecom.TelecomManager
import android.telephony.SubscriptionManager
import android.telephony.TelephonyManager
import android.view.WindowManager
import androidx.annotation.RequiresApi
import androidx.core.content.ContextCompat
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.atomic.AtomicBoolean

class UssdDialerModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("UssdDialer")

    OnCreate {
      protectAppWindow()
    }

    OnActivityEntersForeground {
      protectAppWindow()
    }

    AsyncFunction("getSubscriptions") { promise: Promise ->
      val context = appContext.reactContext
      if (context == null) {
        promise.reject("E_NO_CONTEXT", "Android context is unavailable", null)
        return@AsyncFunction
      }

      if (ContextCompat.checkSelfPermission(context, Manifest.permission.READ_PHONE_STATE) != PackageManager.PERMISSION_GRANTED) {
        promise.reject("E_PERMISSION", "Phone state permission was not granted", null)
        return@AsyncFunction
      }

      try {
        val subscriptionManager = context.getSystemService(Context.TELEPHONY_SUBSCRIPTION_SERVICE) as SubscriptionManager
        val subscriptions = subscriptionManager.activeSubscriptionInfoList.orEmpty()
          .sortedBy { it.simSlotIndex }
          .map { subscription ->
            mapOf(
              "id" to subscription.subscriptionId,
              "slotIndex" to subscription.simSlotIndex,
              "displayName" to subscription.displayName.toString(),
              "carrierName" to subscription.carrierName.toString()
            )
          }
        promise.resolve(subscriptions)
      } catch (error: Exception) {
        promise.reject("E_SUBSCRIPTIONS", error.message ?: "Could not read SIM cards", error)
      }
    }

    AsyncFunction("send") { code: String, subscriptionId: Int, promise: Promise ->
      val context = appContext.reactContext
      if (context == null) {
        promise.reject("E_NO_CONTEXT", "Android context is unavailable", null)
        return@AsyncFunction
      }

      if (!hasPhoneAccess(context)) {
        promise.reject("E_PERMISSION", "SIM and calling permissions must be granted", null)
        return@AsyncFunction
      }

      if (!hasTelephonyHardware(context)) {
        promise.reject("E_NO_TELEPHONY", "This device cannot send USSD requests", null)
        return@AsyncFunction
      }

      val normalizedCode = normalizeUssdCode(code)
      if (normalizedCode == null) {
        promise.reject("E_INVALID_USSD", "Enter a valid USSD code that starts with * or # and ends with #", null)
        return@AsyncFunction
      }
      if (!isActiveSubscription(context, subscriptionId)) {
        promise.reject("E_SIM_UNAVAILABLE", "The selected SIM is no longer available", null)
        return@AsyncFunction
      }

      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
        promise.reject("E_UNSUPPORTED", "Direct USSD responses require Android 8 or newer. Use a saved flow on this phone.", null)
        return@AsyncFunction
      }
      sendDirectUssd(context, normalizedCode, subscriptionId, promise)
    }

    AsyncFunction("isAccessibilityEnabled") {
      val context = appContext.reactContext ?: return@AsyncFunction false
      isAutomationServiceEnabled(context)
    }

    AsyncFunction("openAccessibilitySettings") {
      val context = appContext.reactContext
        ?: throw IllegalStateException("Android context is unavailable")
      context.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).apply {
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      })
    }

    AsyncFunction("startAutomation") { code: String, replies: List<String>, subscriptionId: Int, flowName: String, promise: Promise ->
      val context = appContext.reactContext
      if (context == null) {
        promise.reject("E_NO_CONTEXT", "Android context is unavailable", null)
        return@AsyncFunction
      }
      if (!hasPhoneAccess(context)) {
        promise.reject("E_PERMISSION", "SIM and calling permissions must be granted", null)
        return@AsyncFunction
      }
      if (!hasTelephonyHardware(context)) {
        promise.reject("E_NO_TELEPHONY", "This device cannot place USSD calls", null)
        return@AsyncFunction
      }
      val normalizedCode = normalizeUssdCode(code)
      val normalizedReplies = normalizeReplies(replies)
      if (normalizedCode == null) {
        promise.reject("E_INVALID_USSD", "Enter a valid USSD code that starts with * or # and ends with #", null)
        return@AsyncFunction
      }
      if (normalizedReplies == null) {
        promise.reject("E_INVALID_REPLIES", "Replies must be non-empty, single-line values of at most 160 characters", null)
        return@AsyncFunction
      }
      if (flowName.trim().length > MAX_FLOW_NAME_LENGTH) {
        promise.reject("E_INVALID_FLOW", "Flow names can contain at most $MAX_FLOW_NAME_LENGTH characters", null)
        return@AsyncFunction
      }
      if (!isActiveSubscription(context, subscriptionId)) {
        promise.reject("E_SIM_UNAVAILABLE", "The selected SIM is no longer available", null)
        return@AsyncFunction
      }
      if (!isAutomationServiceEnabled(context)) {
        promise.reject("E_ACCESSIBILITY", "Enable USSD Flow automation in Accessibility settings first", null)
        return@AsyncFunction
      }
      if (!UssdAutomationService.isConnected()) {
        promise.reject("E_ACCESSIBILITY_NOT_READY", "USSD Flow automation is still connecting. Wait a moment and try again", null)
        return@AsyncFunction
      }
      if (UssdAutomationStore.hasActiveWork(context)) {
        promise.reject("E_ALREADY_RUNNING", "Another USSD flow or recording is already active. Stop it before starting a new one", null)
        return@AsyncFunction
      }

      try {
        val telecomManager = context.getSystemService(Context.TELECOM_SERVICE) as TelecomManager
        val selectedAccount = findCallingAccount(context, telecomManager, subscriptionId)
        if (selectedAccount == null) {
          promise.reject("E_SIM_UNAVAILABLE", "Android could not match the selected SIM to a calling account", null)
          return@AsyncFunction
        }

        if (!UssdAutomationStore.arm(context, normalizedCode, normalizedReplies, subscriptionId, flowName.trim())) {
          val code = if (UssdAutomationStore.hasActiveWork(context)) "E_ALREADY_RUNNING" else "E_STORAGE"
          val message = if (code == "E_ALREADY_RUNNING") {
            "Another USSD flow or recording started first. Stop it before trying again"
          } else {
            "The flow could not be saved securely before dialing"
          }
          promise.reject(code, message, null)
          return@AsyncFunction
        }
        val extras = Bundle().apply {
          putParcelable(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, selectedAccount)
        }
        telecomManager.placeCall(Uri.fromParts("tel", normalizedCode, null), extras)
        promise.resolve(null)
      } catch (error: Exception) {
        UssdAutomationStore.stop(context, "failed_to_start", "Android could not start the USSD call.")
        promise.reject("E_AUTOMATION", error.message ?: "Could not start the USSD route", error)
      }
    }

    AsyncFunction("cancelAutomation") {
      val context = appContext.reactContext ?: throw IllegalStateException("Android context is unavailable")
      if (!UssdAutomationStore.stop(context, "cancelled", "USSD flow was stopped by the user.")) {
        throw IllegalStateException("The stop state could not be saved securely. Automation was disabled as a precaution.")
      }
    }

    AsyncFunction("getAutomationStatus") {
      val context = appContext.reactContext ?: throw IllegalStateException("Android context is unavailable")
      UssdAutomationStore.getAutomationStatus(context)
    }

    AsyncFunction("acknowledgeAutomation") { updatedAt: Double ->
      val context = appContext.reactContext ?: throw IllegalStateException("Android context is unavailable")
      if (!UssdAutomationStore.acknowledgeAutomation(context, updatedAt.toLong())) {
        throw IllegalStateException("The flow result changed before it could be dismissed. Refresh and try again.")
      }
    }

    AsyncFunction("startRecording") { code: String, subscriptionId: Int, promise: Promise ->
      val context = appContext.reactContext
      if (context == null) {
        promise.reject("E_NO_CONTEXT", "Android context is unavailable", null)
        return@AsyncFunction
      }
      if (!hasPhoneAccess(context)) {
        promise.reject("E_PERMISSION", "SIM and calling permissions must be granted", null)
        return@AsyncFunction
      }
      if (!hasTelephonyHardware(context)) {
        promise.reject("E_NO_TELEPHONY", "This device cannot place USSD calls", null)
        return@AsyncFunction
      }
      val normalizedCode = normalizeUssdCode(code)
      if (normalizedCode == null) {
        promise.reject("E_INVALID_USSD", "Enter a valid USSD code that starts with * or # and ends with #", null)
        return@AsyncFunction
      }
      if (!isActiveSubscription(context, subscriptionId)) {
        promise.reject("E_SIM_UNAVAILABLE", "The selected SIM is no longer available", null)
        return@AsyncFunction
      }
      if (!isAutomationServiceEnabled(context)) {
        promise.reject("E_ACCESSIBILITY", "Enable USSD Flow automation in Accessibility settings first", null)
        return@AsyncFunction
      }
      if (!UssdAutomationService.isConnected()) {
        promise.reject("E_ACCESSIBILITY_NOT_READY", "USSD Flow automation is still connecting. Wait a moment and try again", null)
        return@AsyncFunction
      }
      if (UssdAutomationStore.hasActiveWork(context)) {
        promise.reject("E_ALREADY_RUNNING", "Another USSD flow or recording is already active. Stop it before starting a new one", null)
        return@AsyncFunction
      }
      try {
        val telecomManager = context.getSystemService(Context.TELECOM_SERVICE) as TelecomManager
        val selectedAccount = findCallingAccount(context, telecomManager, subscriptionId)
        if (selectedAccount == null) {
          promise.reject("E_SIM_UNAVAILABLE", "Android could not match the selected SIM to a calling account", null)
          return@AsyncFunction
        }
        if (!UssdAutomationStore.startRecording(context, normalizedCode, subscriptionId)) {
          val code = if (UssdAutomationStore.hasActiveWork(context)) "E_ALREADY_RUNNING" else "E_STORAGE"
          val message = if (code == "E_ALREADY_RUNNING") {
            "Another USSD flow or recording started first. Stop it before trying again"
          } else {
            "Recording state could not be saved securely before dialing"
          }
          promise.reject(code, message, null)
          return@AsyncFunction
        }
        val extras = Bundle().apply {
          putParcelable(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, selectedAccount)
        }
        telecomManager.placeCall(Uri.fromParts("tel", normalizedCode, null), extras)
        promise.resolve(null)
      } catch (error: Exception) {
        UssdAutomationStore.finishRecording(context, "failed")
        promise.reject("E_RECORDING", error.message ?: "Could not start recording", error)
      }
    }

    AsyncFunction("finishRecording") {
      val context = appContext.reactContext ?: throw IllegalStateException("Android context is unavailable")
      if (!UssdAutomationStore.finishRecording(context, "stopped")) {
        throw IllegalStateException("The recording result could not be saved securely. Recording was stopped as a precaution.")
      }
      UssdAutomationStore.getRecording(context)
    }

    AsyncFunction("getRecording") {
      val context = appContext.reactContext ?: throw IllegalStateException("Android context is unavailable")
      UssdAutomationStore.getRecording(context)
    }

    AsyncFunction("acknowledgeRecording") { updatedAt: Double ->
      val context = appContext.reactContext ?: throw IllegalStateException("Android context is unavailable")
      if (!UssdAutomationStore.acknowledgeRecording(context, updatedAt.toLong())) {
        throw IllegalStateException("The recording result changed before it could be dismissed. Refresh and try again.")
      }
    }

    AsyncFunction("clearPendingRecording") {
      val context = appContext.reactContext ?: throw IllegalStateException("Android context is unavailable")
      if (!UssdAutomationStore.clearPendingRecording(context)) {
        throw IllegalStateException("Stop the active recording before clearing its result.")
      }
    }

    AsyncFunction("getSavedFlows") {
      val context = appContext.reactContext ?: throw IllegalStateException("Android context is unavailable")
      UssdAutomationStore.getSavedFlows(context)
    }

    AsyncFunction("saveFlow") { name: String, code: String, replies: List<String>, subscriptionId: Int ->
      val context = appContext.reactContext ?: throw IllegalStateException("Android context is unavailable")
      val cleanName = name.trim()
      val normalizedCode = normalizeUssdCode(code)
        ?: throw IllegalArgumentException("Enter a valid USSD code that starts with * or # and ends with #")
      val normalizedReplies = normalizeReplies(replies)
        ?: throw IllegalArgumentException("Add 1 to $MAX_AUTOMATION_STEPS valid replies or a CANCEL step")
      if (cleanName.isEmpty() || cleanName.length > MAX_FLOW_NAME_LENGTH) {
        throw IllegalArgumentException("Flow names must contain 1 to $MAX_FLOW_NAME_LENGTH characters")
      }
      if (!isActiveSubscription(context, subscriptionId)) {
        throw IllegalStateException("The selected SIM is no longer available")
      }
      if (!UssdAutomationStore.saveFlow(context, cleanName, normalizedCode, normalizedReplies, subscriptionId)) {
        throw IllegalStateException("The flow could not be saved securely. Your existing saved flows were left unchanged.")
      }
    }

    AsyncFunction("deleteFlow") { id: String ->
      val context = appContext.reactContext ?: throw IllegalStateException("Android context is unavailable")
      if (id.isBlank()) throw IllegalArgumentException("A saved-flow ID is required")
      if (!UssdAutomationStore.deleteFlow(context, id)) {
        throw IllegalStateException("The saved flow could not be deleted securely")
      }
    }

    AsyncFunction("getResponseHistory") {
      val context = appContext.reactContext ?: throw IllegalStateException("Android context is unavailable")
      UssdAutomationStore.getResponseHistory(context)
    }

    AsyncFunction("clearResponseHistory") {
      val context = appContext.reactContext ?: throw IllegalStateException("Android context is unavailable")
      if (!UssdAutomationStore.clearResponseHistory(context)) {
        throw IllegalStateException("Stop the active USSD flow or recording before clearing history, then try again")
      }
    }

    AsyncFunction("openDialer") { code: String ->
      val context = appContext.reactContext
        ?: throw IllegalStateException("Android context is unavailable")
      val normalizedCode = normalizeUssdCode(code)
        ?: throw IllegalArgumentException("Enter a valid USSD code that starts with * or # and ends with #")
      val intent = Intent(Intent.ACTION_DIAL, Uri.parse("tel:${Uri.encode(normalizedCode)}")).apply {
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      context.startActivity(intent)
    }
  }

  private fun hasTelephonyHardware(context: Context): Boolean {
    val packageManager = context.packageManager
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      packageManager.hasSystemFeature(PackageManager.FEATURE_TELEPHONY_RADIO_ACCESS) ||
        packageManager.hasSystemFeature(PackageManager.FEATURE_TELEPHONY)
    } else {
      packageManager.hasSystemFeature(PackageManager.FEATURE_TELEPHONY)
    }
  }

  private fun protectAppWindow() {
    val activity = appContext.currentActivity ?: return
    activity.runOnUiThread {
      activity.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
    }
  }

  private fun hasPhoneAccess(context: Context): Boolean =
    ContextCompat.checkSelfPermission(context, Manifest.permission.CALL_PHONE) == PackageManager.PERMISSION_GRANTED &&
      ContextCompat.checkSelfPermission(context, Manifest.permission.READ_PHONE_STATE) == PackageManager.PERMISSION_GRANTED

  @RequiresApi(Build.VERSION_CODES.O)
  private fun sendDirectUssd(context: Context, code: String, subscriptionId: Int, promise: Promise) {
    val baseTelephonyManager = context.getSystemService(Context.TELEPHONY_SERVICE) as TelephonyManager
    val telephonyManager = if (SubscriptionManager.isValidSubscriptionId(subscriptionId)) {
      baseTelephonyManager.createForSubscriptionId(subscriptionId)
    } else {
      baseTelephonyManager
    }
    val handler = Handler(Looper.getMainLooper())
    val completed = AtomicBoolean(false)
    val timeout = Runnable {
      if (completed.compareAndSet(false, true)) {
        promise.reject("E_USSD_TIMEOUT", "The carrier did not return a USSD response within 45 seconds", null)
      }
    }
    val callback = object : TelephonyManager.UssdResponseCallback() {
      override fun onReceiveUssdResponse(manager: TelephonyManager, request: String, response: CharSequence) {
        if (completed.compareAndSet(false, true)) {
          handler.removeCallbacks(timeout)
          promise.resolve(response.toString())
        }
      }

      override fun onReceiveUssdResponseFailed(manager: TelephonyManager, request: String, failureCode: Int) {
        if (completed.compareAndSet(false, true)) {
          handler.removeCallbacks(timeout)
          promise.reject("E_USSD_FAILED", ussdFailureMessage(failureCode), null)
        }
      }
    }

    try {
      handler.postDelayed(timeout, DIRECT_USSD_TIMEOUT_MS)
      telephonyManager.sendUssdRequest(code, callback, handler)
    } catch (error: Exception) {
      if (completed.compareAndSet(false, true)) {
        handler.removeCallbacks(timeout)
        promise.reject("E_USSD_ERROR", error.message ?: "USSD request failed", error)
      }
    }
  }

  private fun isActiveSubscription(context: Context, subscriptionId: Int): Boolean {
    if (!SubscriptionManager.isValidSubscriptionId(subscriptionId)) return false
    return try {
      val manager = context.getSystemService(Context.TELEPHONY_SUBSCRIPTION_SERVICE) as SubscriptionManager
      manager.activeSubscriptionInfoList.orEmpty().any { it.subscriptionId == subscriptionId }
    } catch (_: SecurityException) {
      false
    }
  }

  private fun normalizeUssdCode(value: String): String? {
    val code = value.replace(Regex("\\s+"), "").trim()
    if (code.length !in 3..MAX_USSD_CODE_LENGTH) return null
    if (code.firstOrNull() !in setOf('*', '#') || !code.endsWith('#')) return null
    if (!code.matches(Regex("^[*#][0-9*#]+#$"))) return null
    return code
  }

  private fun normalizeReplies(replies: List<String>): List<String>? {
    if (replies.isEmpty() || replies.size > MAX_AUTOMATION_STEPS) return null
    val normalized = replies.map(String::trim)
    if (normalized.any {
        it.isEmpty() || it.length > MAX_REPLY_LENGTH || it.any(Char::isISOControl)
      }) return null
    return normalized
  }

  private fun ussdFailureMessage(failureCode: Int): String = when (failureCode) {
    TelephonyManager.USSD_RETURN_FAILURE -> "The carrier rejected or could not process the USSD request"
    TelephonyManager.USSD_ERROR_SERVICE_UNAVAIL -> "USSD service is unavailable. Check signal and try again"
    else -> "USSD request failed (code $failureCode)"
  }

  private fun findCallingAccount(context: Context, telecomManager: TelecomManager, subscriptionId: Int) =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      val telephonyManager = context.getSystemService(Context.TELEPHONY_SERVICE) as TelephonyManager
      telecomManager.callCapablePhoneAccounts.firstOrNull { handle ->
        telephonyManager.getSubscriptionId(handle) == subscriptionId
      }
    } else {
      val accounts = telecomManager.callCapablePhoneAccounts
      val exactId = subscriptionId.toString()
      val idPattern = Regex("(^|\\D)${Regex.escape(exactId)}(\\D|$)")
      accounts.firstOrNull { it.id == exactId || idPattern.containsMatchIn(it.id) }
    }

  private fun isAutomationServiceEnabled(context: Context): Boolean {
    val expected = ComponentName(context, UssdAutomationService::class.java)
    val enabledServices = Settings.Secure.getString(
      context.contentResolver,
      Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
    ).orEmpty()
    return enabledServices.split(':')
      .mapNotNull(ComponentName::unflattenFromString)
      .any { it == expected }
  }

  companion object {
    private const val DIRECT_USSD_TIMEOUT_MS = 45_000L
    private const val MAX_USSD_CODE_LENGTH = 80
    private const val MAX_REPLY_LENGTH = 160
    private const val MAX_AUTOMATION_STEPS = 50
    private const val MAX_FLOW_NAME_LENGTH = 80
  }
}
