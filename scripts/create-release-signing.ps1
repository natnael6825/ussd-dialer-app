param(
  [string]$OutputDirectory = (Join-Path $env:USERPROFILE '.android\ussd-flow-release')
)

$ErrorActionPreference = 'Stop'
$outputPath = [System.IO.Path]::GetFullPath($OutputDirectory)
$keystorePath = Join-Path $outputPath 'ussd-flow-release-secure.p12'
$credentialsPath = Join-Path $outputPath 'credentials-secure.txt'

New-Item -ItemType Directory -Path $outputPath -Force | Out-Null
if ((Test-Path -LiteralPath $keystorePath) -or (Test-Path -LiteralPath $credentialsPath)) {
  throw 'Secure release signing files already exist; refusing to overwrite them.'
}

$passwordBytes = New-Object byte[] 32
$generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try {
  $generator.GetBytes($passwordBytes)
} finally {
  $generator.Dispose()
}

$password = ([System.BitConverter]::ToString($passwordBytes)).Replace('-', '').ToLowerInvariant()
if ($password.Length -ne 64 -or $password -eq ('0' * 64)) {
  throw 'Cryptographic password generation failed.'
}

$env:USSD_RELEASE_STORE_PASS = $password
try {
  & keytool `
    -genkeypair `
    -v `
    -storetype PKCS12 `
    -keystore $keystorePath `
    -storepass:env USSD_RELEASE_STORE_PASS `
    -alias ussd-flow `
    -keyalg RSA `
    -keysize 4096 `
    -sigalg SHA256withRSA `
    -validity 9125 `
    -dname 'CN=USSD Flow, OU=Mobile, O=Natnael, C=ET'
  if ($LASTEXITCODE -ne 0) {
    throw 'keytool failed to create the release keystore.'
  }
} finally {
  Remove-Item Env:\USSD_RELEASE_STORE_PASS -ErrorAction SilentlyContinue
}

$credentials = @(
  'USSD Flow release signing credentials'
  ''
  'Keystore: ussd-flow-release-secure.p12'
  'Alias: ussd-flow'
  "Password: $password"
  ''
  'Keep this folder private and back it up offline.'
  'Losing this keystore or password prevents future signed updates.'
) -join [Environment]::NewLine

[System.IO.File]::WriteAllText(
  $credentialsPath,
  $credentials,
  [System.Text.UTF8Encoding]::new($false)
)

icacls $outputPath /inheritance:r /grant:r "$env:USERNAME`:(OI)(CI)F" | Out-Null
Write-Output 'Secure release signing files created.'
