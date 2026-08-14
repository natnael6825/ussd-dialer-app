package com.fikre.ussddialer

internal object FlowTemplates {
  // Escape both closing braces explicitly. Android's ICU regex engine treats
  // an unescaped `}` as a syntax error even though the desktop JDK accepts it.
  private val placeholder = Regex("^\\{\\{([a-z][a-z0-9_]{0,31})\\}\\}$")
  private val forbiddenVariables = setOf("pin", "password", "passcode", "otp", "secret")

  data class Validation(val requiredVariables: List<String>, val error: String? = null)

  fun validateSavedReplies(replies: List<String>): Validation {
    val variables = linkedSetOf<String>()
    for (reply in replies) {
      val match = placeholder.matchEntire(reply)
      if (match != null) {
        val name = match.groupValues[1]
        if (name in forbiddenVariables) {
          return Validation(emptyList(), "Sensitive placeholder {{$name}} is not allowed. Keep that value as a local phone-only reply.")
        }
        variables += name
        if (variables.size > 20) {
          return Validation(emptyList(), "A flow can contain at most 20 different variables.")
        }
      } else if (reply.contains("{{") || reply.contains("}}")) {
        return Validation(emptyList(), "A variable must fill an entire reply, for example {{amount}}.")
      }
    }
    return Validation(variables.toList().sorted())
  }

  fun hasPlaceholder(replies: List<String>): Boolean = replies.any { placeholder.matches(it) }

  fun substitute(replies: List<String>, variables: Map<String, String>): Pair<List<String>?, String?> {
    val validation = validateSavedReplies(replies)
    validation.error?.let { return null to it }
    val required = validation.requiredVariables.toSet()
    val supplied = variables.keys
    val missing = required - supplied
    if (missing.isNotEmpty()) return null to "Missing variables: ${missing.sorted().joinToString(", ")}."
    val unexpected = supplied - required
    if (unexpected.isNotEmpty()) return null to "Unexpected variables: ${unexpected.sorted().joinToString(", ")}."

    val clean = linkedMapOf<String, String>()
    for ((name, rawValue) in variables) {
      if (!placeholder.matches("{{$name}}") || name in forbiddenVariables) {
        return null to "Variable name '$name' is not allowed."
      }
      val value = rawValue
      if (value.isEmpty() || value.length > 160 || value.any(Char::isISOControl)) {
        return null to "Variable '$name' must be a printable, single-line value of 1 to 160 characters."
      }
      if (value.trim().equals("CANCEL", ignoreCase = true)) {
        return null to "Variable '$name' cannot resolve to the CANCEL command."
      }
      if (value.contains("{{") || value.contains("}}")) {
        return null to "Variable '$name' cannot contain another placeholder."
      }
      clean[name] = value
    }

    return replies.map { reply ->
      val match = placeholder.matchEntire(reply)
      if (match == null) reply else clean.getValue(match.groupValues[1])
    } to null
  }
}
