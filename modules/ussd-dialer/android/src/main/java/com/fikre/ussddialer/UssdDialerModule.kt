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
import android.util.Log
import androidx.annotation.RequiresApi
import androidx.core.content.ContextCompat
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class UssdDialerModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("UssdDialer")

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

      if (ContextCompat.checkSelfPermission(context, Manifest.permission.CALL_PHONE) != PackageManager.PERMISSION_GRANTED) {
        promise.reject("E_PERMISSION", "Phone permission was not granted", null)
        return@AsyncFunction
      }

      if (!hasTelephonyHardware(context)) {
        promise.reject("E_NO_TELEPHONY", "This device cannot send USSD requests", null)
        return@AsyncFunction
      }

      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
        promise.reject("E_UNSUPPORTED", "Direct USSD responses require Android 8 or newer. Use a saved flow on this phone.", null)
        return@AsyncFunction
      }
      sendDirectUssd(context, code, subscriptionId, promise)
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
      if (ContextCompat.checkSelfPermission(context, Manifest.permission.CALL_PHONE) != PackageManager.PERMISSION_GRANTED) {
        promise.reject("E_PERMISSION", "Phone permission was not granted", null)
        return@AsyncFunction
      }
      if (!isAutomationServiceEnabled(context)) {
        promise.reject("E_ACCESSIBILITY", "Enable USSD Flow automation in Accessibility settings first", null)
        return@AsyncFunction
      }

      try {
        val telecomManager = context.getSystemService(Context.TELECOM_SERVICE) as TelecomManager
        val selectedAccount = findCallingAccount(context, telecomManager, subscriptionId)

        UssdAutomationStore.arm(context, code, replies, subscriptionId, flowName)
        val extras = Bundle().apply {
          selectedAccount?.let { putParcelable(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, it) }
        }
        telecomManager.placeCall(Uri.fromParts("tel", code, null), extras)
        promise.resolve(null)
      } catch (error: Exception) {
        UssdAutomationStore.stop(context)
        promise.reject("E_AUTOMATION", error.message ?: "Could not start the USSD route", error)
      }
    }

    AsyncFunction("cancelAutomation") {
      appContext.reactContext?.let { UssdAutomationStore.stop(it, "stopped") }
    }

    AsyncFunction("startRecording") { code: String, subscriptionId: Int, promise: Promise ->
      val context = appContext.reactContext
      if (context == null) {
        promise.reject("E_NO_CONTEXT", "Android context is unavailable", null)
        return@AsyncFunction
      }
      if (ContextCompat.checkSelfPermission(context, Manifest.permission.CALL_PHONE) != PackageManager.PERMISSION_GRANTED) {
        promise.reject("E_PERMISSION", "Phone permission was not granted", null)
        return@AsyncFunction
      }
      if (!isAutomationServiceEnabled(context)) {
        promise.reject("E_ACCESSIBILITY", "Enable USSD Flow automation in Accessibility settings first", null)
        return@AsyncFunction
      }
      try {
        val telecomManager = context.getSystemService(Context.TELECOM_SERVICE) as TelecomManager
        val selectedAccount = findCallingAccount(context, telecomManager, subscriptionId)
        UssdAutomationStore.startRecording(context, code, subscriptionId)
        val extras = Bundle().apply {
          selectedAccount?.let { putParcelable(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, it) }
        }
        telecomManager.placeCall(Uri.fromParts("tel", code, null), extras)
        promise.resolve(null)
      } catch (error: Exception) {
        UssdAutomationStore.finishRecording(context, "failed")
        promise.reject("E_RECORDING", error.message ?: "Could not start recording", error)
      }
    }

    AsyncFunction("finishRecording") {
      val context = appContext.reactContext ?: throw IllegalStateException("Android context is unavailable")
      UssdAutomationStore.finishRecording(context, "stopped")
      UssdAutomationStore.getRecording(context)
    }

    AsyncFunction("getRecording") {
      val context = appContext.reactContext ?: throw IllegalStateException("Android context is unavailable")
      UssdAutomationStore.getRecording(context)
    }

    AsyncFunction("acknowledgeRecording") { updatedAt: Double ->
      val context = appContext.reactContext ?: throw IllegalStateException("Android context is unavailable")
      UssdAutomationStore.acknowledgeRecording(context, updatedAt.toLong())
    }

    AsyncFunction("clearPendingRecording") {
      val context = appContext.reactContext ?: throw IllegalStateException("Android context is unavailable")
      UssdAutomationStore.clearPendingRecording(context)
    }

    AsyncFunction("getSavedFlows") {
      val context = appContext.reactContext ?: throw IllegalStateException("Android context is unavailable")
      UssdAutomationStore.getSavedFlows(context)
    }

    AsyncFunction("saveFlow") { name: String, code: String, replies: List<String>, subscriptionId: Int ->
      val context = appContext.reactContext ?: throw IllegalStateException("Android context is unavailable")
      UssdAutomationStore.saveFlow(context, name, code, replies, subscriptionId)
    }

    AsyncFunction("deleteFlow") { id: String ->
      val context = appContext.reactContext ?: throw IllegalStateException("Android context is unavailable")
      UssdAutomationStore.deleteFlow(context, id)
    }

    AsyncFunction("getResponseHistory") {
      val context = appContext.reactContext ?: throw IllegalStateException("Android context is unavailable")
      UssdAutomationStore.getResponseHistory(context)
    }

    AsyncFunction("clearResponseHistory") {
      val context = appContext.reactContext ?: throw IllegalStateException("Android context is unavailable")
      UssdAutomationStore.clearResponseHistory(context)
    }

    AsyncFunction("openDialer") { code: String ->
      val context = appContext.reactContext
        ?: throw IllegalStateException("Android context is unavailable")
      val intent = Intent(Intent.ACTION_DIAL, Uri.parse("tel:${Uri.encode(code)}")).apply {
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

  @RequiresApi(Build.VERSION_CODES.O)
  private fun sendDirectUssd(context: Context, code: String, subscriptionId: Int, promise: Promise) {
    val baseTelephonyManager = context.getSystemService(Context.TELEPHONY_SERVICE) as TelephonyManager
    val telephonyManager = if (SubscriptionManager.isValidSubscriptionId(subscriptionId)) {
      baseTelephonyManager.createForSubscriptionId(subscriptionId)
    } else {
      baseTelephonyManager
    }
    Log.i("UssdDialer", "Sending USSD on selected subscription $subscriptionId")
    val callback = object : TelephonyManager.UssdResponseCallback() {
      override fun onReceiveUssdResponse(manager: TelephonyManager, request: String, response: CharSequence) {
        promise.resolve(response.toString())
      }

      override fun onReceiveUssdResponseFailed(manager: TelephonyManager, request: String, failureCode: Int) {
        promise.reject("E_USSD_FAILED", "USSD request failed (code $failureCode)", null)
      }
    }

    try {
      telephonyManager.sendUssdRequest(code, callback, Handler(Looper.getMainLooper()))
    } catch (error: Exception) {
      promise.reject("E_USSD_ERROR", error.message ?: "USSD request failed", error)
    }
  }

  private fun findCallingAccount(context: Context, telecomManager: TelecomManager, subscriptionId: Int) =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      val telephonyManager = context.getSystemService(Context.TELEPHONY_SERVICE) as TelephonyManager
      telecomManager.callCapablePhoneAccounts.firstOrNull { handle ->
        telephonyManager.getSubscriptionId(handle) == subscriptionId
      }
    } else {
      val accounts = telecomManager.callCapablePhoneAccounts
      accounts.firstOrNull { it.id.contains(subscriptionId.toString()) } ?: run {
        val subscriptionManager = context.getSystemService(Context.TELEPHONY_SUBSCRIPTION_SERVICE) as SubscriptionManager
        val selectedIndex = subscriptionManager.activeSubscriptionInfoList.orEmpty()
          .sortedBy { it.simSlotIndex }
          .indexOfFirst { it.subscriptionId == subscriptionId }
        accounts.getOrNull(selectedIndex)
      }
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
}
