#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Runs the Kaggle CLI with the credentials from the repository's .env.

.DESCRIPTION
    Kaggle CLI 2.x reads KAGGLE_API_TOKEN from the environment; it does not read
    .env files.  This wrapper loads <repo>/.env into the environment of this
    process only, then forwards every argument to `kaggle`, so the token never
    has to be exported by hand in each new shell.

    Variables already set in the shell win over the file, and a variable set to
    an empty value in the file is treated as unset.

.EXAMPLE
    ./training/kaggle/kaggle.ps1 quota

.EXAMPLE
    ./training/kaggle/kaggle.ps1 kernels push -p training/kaggle

.EXAMPLE
    ./training/kaggle/kaggle.ps1 kernels logs mccarron/pikafish-js-distill

.NOTES
    Use `kaggle auth login` instead if you would rather authenticate through the
    browser; then this wrapper is not needed.
#>
# No `[CmdletBinding()]` and no declared parameters on purpose: an advanced
# script owns the common parameters, so `-p training/kaggle` would bind to
# `-PipelineVariable` and never reach the CLI.  `$args` forwards everything
# exactly as typed.
$ErrorActionPreference = 'Stop'
$Command = $args

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$envFile = Join-Path $repoRoot '.env'

if (Test-Path -LiteralPath $envFile) {
    foreach ($line in Get-Content -LiteralPath $envFile) {
        $text = $line.Trim()
        if (-not $text -or $text.StartsWith('#')) { continue }
        if ($text -notmatch '^(?<name>[A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?<value>.*)$') { continue }

        $name = $Matches.name
        $value = $Matches.value.Trim()
        if ($value.Length -ge 2 -and ($value[0] -eq '"' -or $value[0] -eq "'") -and $value[-1] -eq $value[0]) {
            $value = $value.Substring(1, $value.Length - 2)
        }

        # An empty assignment in the file must not shadow a real value from the
        # shell, and an explicit environment value must win over the file.
        if (-not $value) { continue }
        if ([Environment]::GetEnvironmentVariable($name)) { continue }
        Set-Item -Path "Env:$name" -Value $value
    }
}

# Commands that never talk to the API must work without credentials.
$needsAuth = -not ($Command | Where-Object { $_ -in @('--help', '-h', '--version', '-v', 'auth', 'config') })

$hasToken = [bool]$env:KAGGLE_API_TOKEN
$hasJson = Test-Path -LiteralPath (Join-Path $HOME '.kaggle/kaggle.json')
if ($needsAuth -and -not $hasToken -and -not $hasJson) {
    Write-Error @"
No Kaggle credentials found.

  Fill KAGGLE_API_TOKEN in $envFile  (token: https://www.kaggle.com/settings/api)
  or run: kaggle auth login
"@
}

if ($hasToken) {
    $shown = if ($env:KAGGLE_API_TOKEN.Length -gt 8) {
        $env:KAGGLE_API_TOKEN.Substring(0, 8) + '...'
    } else {
        '...'
    }
    Write-Verbose "using KAGGLE_API_TOKEN $shown"
}

& kaggle @Command
exit $LASTEXITCODE
