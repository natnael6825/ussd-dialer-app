package com.fikre.ussddialer

import android.Manifest
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager
import android.telephony.SubscriptionManager
import android.telephony.TelephonyManager
import androidx.core.content.ContextCompat

internal object UssdAutomationLauncher {
  data class Result(val started: Boolean, val code: String, val message: String, val sessionId: String = "")

  fun start(
    context: Context,
    code: String,
    replies: List<String>,
    subscriptionId: Int,
    flowName: String,
    preserveReplyWhitespace: Boolean = false,
    backendJobId: String = ""
  ): Result {
    if (!hasPhoneAccess(context)) return rejected("E_PERMISSION", "SIM and calling permissions must be granted")
    if (!hasTelephonyHardware(context)) return rejected("E_NO_TELEPHONY", "This device cannot place USSD calls")
    val normalizedCode = normalizeUssdCode(code)
      ?: return rejected("E_INVALID_USSD", "Enter a valid USSD code that starts with * or # and ends with #")
    val normalizedReplies = normalizeReplies(replies, preserveReplyWhitespace)
      ?: return rejected("E_INVALID_REPLIES", "Replies must be non-empty, single-line values of at most 160 characters")
    val templateValidation = FlowTemplates.validateSavedReplies(normalizedReplies)
    if (templateValidation.error != null) return rejected("E_INVALID_REPLIES", templateValidation.error)
    if (templateValidation.requiredVariables.isNotEmpty()) {
      return rejected("E_VARIABLES_REQUIRED", "This flow contains variables and must be run with resolved values")
    }
    val cleanName = flowName.trim()
    if (cleanName.length > MAX_FLOW_NAME_LENGTH) return rejected("E_INVALID_FLOW", "Flow names can contain at most $MAX_FLOW_NAME_LENGTH characters")
    if (!isActiveSubscription(context, subscriptionId)) return rejected("E_SIM_UNAVAILABLE", "The selected SIM is no longer available")
    if (!isAutomationServiceEnabled(context)) return rejected("E_ACCESSIBILITY", "Enable USSD Flow automation in Accessibility settings first")
    if (!UssdAutomationService.isConnected()) return rejected("E_ACCESSIBILITY_NOT_READY", "USSD Flow automation is still connecting. Wait a moment and try again")
    if (UssdAutomationStore.hasActiveWork(context)) return rejected("E_ALREADY_RUNNING", "Another USSD flow or recording is already active")

    val telecomManager = context.getSystemService(Context.TELECOM_SERVICE) as TelecomManager
    val selectedAccount = findCallingAccount(context, telecomManager, subscriptionId)
      ?: return rejected("E_SIM_UNAVAILABLE", "Android could not match the selected SIM to a calling account")
    if (!UssdAutomationStore.arm(context, normalizedCode, normalizedReplies, subscriptionId, cleanName, backendJobId)) {
      return if (UssdAutomationStore.hasActiveWork(context)) {
        rejected("E_ALREADY_RUNNING", "Another USSD flow or recording started first")
      } else rejected("E_STORAGE", "The flow could not be saved securely before dialing")
    }
    return try {
      val extras = Bundle().apply { putParcelable(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, selectedAccount) }
      telecomManager.placeCall(Uri.fromParts("tel", normalizedCode, null), extras)
      val sessionId = UssdAutomationStore.getAutomationStatus(context)["sessionId"]?.toString().orEmpty()
      Result(true, "OK", "USSD flow started", sessionId)
    } catch (error: Exception) {
      UssdAutomationStore.stop(context, "failed_to_start", "Android could not start the USSD call.")
      rejected("E_AUTOMATION", error.message ?: "Could not start the USSD route")
    }
  }

  private fun rejected(code: String, message: String) = Result(false, code, message)

  private fun hasPhoneAccess(context: Context): Boolean =
    ContextCompat.checkSelfPermission(context, Manifest.permission.CALL_PHONE) == PackageManager.PERMISSION_GRANTED &&
      ContextCompat.checkSelfPermission(context, Manifest.permission.READ_PHONE_STATE) == PackageManager.PERMISSION_GRANTED

  private fun hasTelephonyHardware(context: Context): Boolean =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      context.packageManager.hasSystemFeature(PackageManager.FEATURE_TELEPHONY_RADIO_ACCESS) ||
        context.packageManager.hasSystemFeature(PackageManager.FEATURE_TELEPHONY)
    } else context.packageManager.hasSystemFeature(PackageManager.FEATURE_TELEPHONY)

  private fun isActiveSubscription(context: Context, subscriptionId: Int): Boolean {
    if (!SubscriptionManager.isValidSubscriptionId(subscriptionId)) return false
    return try {
      val manager = context.getSystemService(Context.TELEPHONY_SUBSCRIPTION_SERVICE) as SubscriptionManager
      manager.activeSubscriptionInfoList.orEmpty().any { it.subscriptionId == subscriptionId }
    } catch (_: SecurityException) { false }
  }

  private fun findCallingAccount(context: Context, telecomManager: TelecomManager, subscriptionId: Int): PhoneAccountHandle? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      val telephony = context.getSystemService(Context.TELEPHONY_SERVICE) as TelephonyManager
      telecomManager.callCapablePhoneAccounts.firstOrNull { telephony.getSubscriptionId(it) == subscriptionId }
    } else {
      val exact = subscriptionId.toString()
      val pattern = Regex("(^|\\D)${Regex.escape(exact)}(\\D|$)")
      telecomManager.callCapablePhoneAccounts.firstOrNull { it.id == exact || pattern.containsMatchIn(it.id) }
    }

  private fun isAutomationServiceEnabled(context: Context): Boolean {
    val expected = ComponentName(context, UssdAutomationService::class.java)
    return Settings.Secure.getString(context.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES)
      .orEmpty().split(':').mapNotNull(ComponentName::unflattenFromString).any { it == expected }
  }

  private fun normalizeUssdCode(value: String): String? {
    val code = value.replace(Regex("\\s+"), "").trim()
    return code.takeIf {
      it.length in 3..80 && it.firstOrNull() in setOf('*', '#') && it.endsWith('#') && it.matches(Regex("^[*#][0-9*#]+#$"))
    }
  }

  private fun normalizeReplies(replies: List<String>, preserveWhitespace: Boolean): List<String>? {
    if (replies.isEmpty() || replies.size > 50) return null
    val normalized = if (preserveWhitespace) replies.toList() else replies.map(String::trim)
    return normalized.takeUnless { values -> values.any { it.isEmpty() || it.length > 160 || it.any(Char::isISOControl) } }
  }

  private const val MAX_FLOW_NAME_LENGTH = 80
}
