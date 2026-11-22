[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('baseline', 'optimized')]
  [string]$Target,
  [int[]]$Vus = @(10, 25, 50, 100, 200, 400, 800)
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($env:VENUEFLOW_CUSTOMER_TOKEN)) {
  throw 'Set VENUEFLOW_CUSTOMER_TOKEN in this PowerShell session before running the sweep.'
}
if ([string]::IsNullOrWhiteSpace($env:VENUEFLOW_BENCHMARK_SECRET)) {
  throw 'Set VENUEFLOW_BENCHMARK_SECRET in this PowerShell session before running the sweep.'
}

function Find-K6 {
  $installed = Get-Command k6 -ErrorAction SilentlyContinue
  if ($installed) { return $installed.Source }
  $portableRoot = Join-Path $env:TEMP 'venueflow-k6-v2.2.0'
  $portable = Get-ChildItem -Path $portableRoot -Filter 'k6.exe' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
  if ($portable) { return $portable }
  throw 'k6 was not found. Install it or extract the portable binary into the temporary Venueflow k6 folder.'
}

$k6 = Find-K6
$baseUrl = switch ($Target) {
  'baseline' { 'https://venueflow-baseline.samjhonson932.workers.dev' }
  'optimized' { 'https://venueflow-production.samjhonson932.workers.dev' }
}
$runDirectory = Join-Path $PSScriptRoot ("results\{0}-{1}" -f $Target, (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $runDirectory -Force | Out-Null
$rows = @()

Write-Host "Venueflow $Target booking sweep" -ForegroundColor Cyan
Write-Host "Target: $baseUrl"
Write-Host 'Each VU submits one unique synthetic booking. A new 10,000-ticket event is created per stage.'

foreach ($vu in $Vus) {
  $summaryPath = Join-Path $runDirectory ("{0}-vus-summary.json" -f $vu)
  Write-Host "`n=== ${Target}: $vu concurrent booking attempts ===" -ForegroundColor Yellow
  & $k6 run --no-color --summary-time-unit ms --summary-export $summaryPath `
    -e "BASE_URL=$baseUrl" `
    -e "CUSTOMER_TOKEN=$env:VENUEFLOW_CUSTOMER_TOKEN" `
    -e "BENCHMARK_SECRET=$env:VENUEFLOW_BENCHMARK_SECRET" `
    -e "VUS=$vu" `
    (Join-Path $PSScriptRoot 'k6-booking.js')
  $exitCode = $LASTEXITCODE
  if (-not (Test-Path $summaryPath)) { throw "k6 did not create a summary for $vu VUs." }
  $summary = Get-Content -Raw $summaryPath | ConvertFrom-Json
  $metrics = $summary.metrics
  $accepted = $summary.root_group.checks.'booking accepted'
  $rows += [PSCustomObject]@{
    Target = $Target
    VUs = $vu
    'Booking accepted' = $accepted.passes
    'Booking rejected' = $accepted.fails
    'HTTP failures (%)' = [Math]::Round($metrics.http_req_failed.value * 100, 2)
    'p95 (ms)' = [Math]::Round($metrics.http_req_duration.'p(95)', 2)
    'Checks passed (%)' = [Math]::Round($metrics.checks.value * 100, 2)
    'k6 exit code' = $exitCode
  }
}

$csvPath = Join-Path $runDirectory 'comparison.csv'
$rows | Export-Csv -NoTypeInformation -Path $csvPath
Write-Host "`n=== $Target summary ===" -ForegroundColor Cyan
$rows | Format-Table -AutoSize
Write-Host "Raw JSON and CSV saved to: $runDirectory" -ForegroundColor Green
