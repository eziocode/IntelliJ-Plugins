# Git Assume Unchanged Plugin - Installation Script for Windows
# Run this script in PowerShell

$ErrorActionPreference = "Stop"

$PluginZip = "gitAssume-1.0-SNAPSHOT.zip"
$PluginDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PluginPath = Join-Path $PluginDir $PluginZip

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "Git Assume Unchanged Plugin Installer" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

# Check if plugin file exists
if (-not (Test-Path $PluginPath)) {
    Write-Host "❌ Error: Plugin file not found: $PluginZip" -ForegroundColor Red
    Write-Host "Please ensure $PluginZip is in the same directory as this script."
    exit 1
}

Write-Host "✅ Found plugin: $PluginZip" -ForegroundColor Green
Write-Host ""

# Detect IntelliJ IDEA installation
$IntellijPluginsDir = Join-Path $env:APPDATA "JetBrains"

Write-Host "📁 IntelliJ plugins directory: $IntellijPluginsDir"
Write-Host ""

# Find the latest IntelliJ IDEA installation
$LatestIdea = $null
if (Test-Path $IntellijPluginsDir) {
    $IdeaDirs = Get-ChildItem -Path $IntellijPluginsDir -Directory -Filter "IntelliJIdea*" | Sort-Object Name -Descending
    if ($IdeaDirs) {
        $LatestIdea = $IdeaDirs[0].FullName
    }
}

if (-not $LatestIdea) {
    Write-Host "⚠️  Could not auto-detect IntelliJ IDEA installation." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Please install the plugin manually:"
    Write-Host "1. Open IntelliJ IDEA"
    Write-Host "2. Go to Settings/Preferences → Plugins"
    Write-Host "3. Click the gear icon ⚙️ → Install Plugin from Disk..."
    Write-Host "4. Select: $PluginPath"
    Write-Host "5. Restart IntelliJ IDEA"
    exit 0
}

$PluginInstallDir = Join-Path $LatestIdea "plugins"
Write-Host "📦 Installing to: $PluginInstallDir" -ForegroundColor Cyan
Write-Host ""

# Create plugins directory if it doesn't exist
if (-not (Test-Path $PluginInstallDir)) {
    New-Item -ItemType Directory -Path $PluginInstallDir -Force | Out-Null
}

# Extract plugin
$PluginName = "git-assume-unchanged"
$PluginExtractDir = Join-Path $PluginInstallDir $PluginName

Write-Host "🔧 Extracting plugin..." -ForegroundColor Cyan
if (Test-Path $PluginExtractDir) {
    Remove-Item -Path $PluginExtractDir -Recurse -Force
}
New-Item -ItemType Directory -Path $PluginExtractDir -Force | Out-Null
Expand-Archive -Path $PluginPath -DestinationPath $PluginExtractDir -Force

Write-Host "✅ Plugin installed successfully!" -ForegroundColor Green
Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "Next Steps:" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "1. Restart IntelliJ IDEA"
Write-Host "2. The plugin will be available in:"
Write-Host "   Right-click file(s) → Git → Git Assume"
Write-Host ""
Write-Host "Features:"
Write-Host "  • Assume Unchanged - Ignore file changes"
Write-Host "  • No Assume Unchanged - Resume tracking"
Write-Host "  • Works with single or multiple files"
Write-Host "==========================================" -ForegroundColor Cyan
