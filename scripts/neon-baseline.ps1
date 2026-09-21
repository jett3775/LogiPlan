[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$CandidateSha,
  [Parameter(Mandatory = $true)][string]$ApprovedSha,
  [Parameter(Mandatory = $true)][string]$ExpectedDatabase,
  [string]$ToolingSha,
  [string]$ApprovedToolingSha,
  [string]$Report,
  [switch]$Write
)

$ErrorActionPreference = "Stop"
$secretNames = @(
  "NEON_ADMIN_DATABASE_URL",
  "NEON_SCHEMA_MIGRATOR_PASSWORD",
  "NEON_DATA_PUBLISHER_PASSWORD",
  "NEON_APP_READER_PASSWORD"
)
$previous = @{}

function Read-SecretText([string]$Name) {
  $secure = Read-Host "$Name（隐藏输入）" -AsSecureString
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  }
  finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
}

$nodeExitCode = $null
$nativePreference = Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue
$previousNativePreference = if ($null -ne $nativePreference) { $nativePreference.Value } else { $null }

try {
  if ($Write) {
    if ([string]::IsNullOrWhiteSpace($ToolingSha) -or [string]::IsNullOrWhiteSpace($ApprovedToolingSha)) {
      throw "-Write 必须同时提供 -ToolingSha 和 -ApprovedToolingSha"
    }
    $previous["LOGIPLAN_APPROVED_TOOLING_SHA"] = [Environment]::GetEnvironmentVariable("LOGIPLAN_APPROVED_TOOLING_SHA", "Process")
    [Environment]::SetEnvironmentVariable("LOGIPLAN_APPROVED_TOOLING_SHA", $ApprovedToolingSha, "Process")
    foreach ($name in $secretNames) {
      $previous[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
      if ([string]::IsNullOrWhiteSpace($previous[$name])) {
        [Environment]::SetEnvironmentVariable($name, (Read-SecretText $name), "Process")
      }
    }
  }
  $arguments = @(
    "scripts/neon-baseline.mjs",
    "--candidate-sha", $CandidateSha,
    "--approved-sha", $ApprovedSha,
    "--expected-database", $ExpectedDatabase
  )
  if (-not [string]::IsNullOrWhiteSpace($ToolingSha)) { $arguments += @("--tooling-sha", $ToolingSha) }
  if ($Write) { $arguments += "--write" }
  if (-not [string]::IsNullOrWhiteSpace($Report)) { $arguments += @("--report", $Report) }
  if ($null -ne $nativePreference) { $PSNativeCommandUseErrorActionPreference = $false }
  & node @arguments
  $nodeExitCode = $LASTEXITCODE
}
finally {
  foreach ($name in $previous.Keys) {
    [Environment]::SetEnvironmentVariable($name, $previous[$name], "Process")
  }
  if ($null -ne $nativePreference) {
    $PSNativeCommandUseErrorActionPreference = $previousNativePreference
  }
}

if ($null -eq $nodeExitCode) { throw "Neon 基线入口未返回有效退出码" }
exit $nodeExitCode
