param(
    [int]$Port = 8765
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$BackupDir = Join-Path $Root "Backup"
$ConfigPath = Join-Path $Root "config.js"

if (-not (Test-Path $BackupDir)) {
    New-Item -ItemType Directory -Path $BackupDir | Out-Null
}

function Send-Bytes {
    param($Context, [byte[]]$Bytes, [string]$ContentType = "application/octet-stream", [int]$Status = 200)
    $Context.Response.StatusCode = $Status
    $Context.Response.ContentType = $ContentType
    $Context.Response.ContentLength64 = $Bytes.Length
    $Context.Response.OutputStream.Write($Bytes, 0, $Bytes.Length)
    $Context.Response.OutputStream.Close()
}

function Send-Text {
    param($Context, [string]$Text, [string]$ContentType = "text/plain; charset=utf-8", [int]$Status = 200)
    $Utf8 = New-Object System.Text.UTF8Encoding($false)
    Send-Bytes -Context $Context -Bytes $Utf8.GetBytes($Text) -ContentType $ContentType -Status $Status
}

function Send-Json {
    param($Context, $Object, [int]$Status = 200)
    $Json = $Object | ConvertTo-Json -Depth 20 -Compress
    Send-Text -Context $Context -Text $Json -ContentType "application/json; charset=utf-8" -Status $Status
}

function Read-Body {
    param($Request)
    $Reader = New-Object System.IO.StreamReader($Request.InputStream, $Request.ContentEncoding)
    try { return $Reader.ReadToEnd() } finally { $Reader.Dispose() }
}

function New-Backup {
    param([string]$Reason = "保存前备份")
    if (-not (Test-Path $ConfigPath)) { return $null }
    $Stamp = Get-Date -Format "yyyyMMdd_HHmmss_fff"
    $SafeReason = ($Reason -replace '[\\/:*?"<>|]', '_')
    if ([string]::IsNullOrWhiteSpace($SafeReason)) { $SafeReason = "备份" }
    $Name = "config_${Stamp}_${SafeReason}.js"
    $Target = Join-Path $BackupDir $Name
    Copy-Item -LiteralPath $ConfigPath -Destination $Target -Force
    return $Name
}

function Get-BackupList {
    $Items = @()
    if (Test-Path $BackupDir) {
        $Items = Get-ChildItem -LiteralPath $BackupDir -File -Filter "config_*.js" |
            Sort-Object LastWriteTime -Descending |
            ForEach-Object {
                [PSCustomObject]@{
                    name = $_.Name
                    time = $_.LastWriteTime.ToString("yyyy-MM-dd HH:mm:ss")
                    size = $_.Length
                }
            }
    }
    return @($Items)
}

function Get-MimeType {
    param([string]$Path)
    switch ([System.IO.Path]::GetExtension($Path).ToLowerInvariant()) {
        ".html" { return "text/html; charset=utf-8" }
        ".htm"  { return "text/html; charset=utf-8" }
        ".js"   { return "text/javascript; charset=utf-8" }
        ".css"  { return "text/css; charset=utf-8" }
        ".json" { return "application/json; charset=utf-8" }
        ".png"  { return "image/png" }
        ".jpg"  { return "image/jpeg" }
        ".jpeg" { return "image/jpeg" }
        ".gif"  { return "image/gif" }
        ".svg"  { return "image/svg+xml" }
        ".wav"  { return "audio/wav" }
        ".mp3"  { return "audio/mpeg" }
        ".ogg"  { return "audio/ogg" }
        ".xlsx" { return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }
        default { return "application/octet-stream" }
    }
}

$Prefix = "http://127.0.0.1:$Port/"
$Listener = New-Object System.Net.HttpListener
$Listener.Prefixes.Add($Prefix)

try {
    $Listener.Start()
} catch {
    Write-Host ""
    Write-Host "无法启动教师后台服务。" -ForegroundColor Red
    Write-Host "可能是端口 $Port 已被占用。请关闭旧窗口后再试。" -ForegroundColor Yellow
    Read-Host "按 Enter 退出"
    exit 1
}

Write-Host "==============================================" -ForegroundColor DarkRed
Write-Host " 梦回大观园｜Windows 教师后台桌面服务" -ForegroundColor DarkRed
Write-Host "==============================================" -ForegroundColor DarkRed
Write-Host "服务地址：$Prefix"
Write-Host "备份位置：$BackupDir"
Write-Host "关闭此窗口即可停止服务。"
Write-Host ""

Start-Process ($Prefix + [Uri]::EscapeDataString("教师版.html"))

while ($Listener.IsListening) {
    try {
        $Context = $Listener.GetContext()
        $Request = $Context.Request
        $Path = [Uri]::UnescapeDataString($Request.Url.AbsolutePath)

        if ($Path -eq "/api/status") {
            Send-Json $Context ([PSCustomObject]@{
                ok = $true
                mode = "windows-desktop"
                root = $Root
                backupDir = $BackupDir
                configExists = (Test-Path $ConfigPath)
            })
            continue
        }

        if ($Path -eq "/api/save-config" -and $Request.HttpMethod -eq "POST") {
            try {
                $Body = Read-Body $Request
                $Payload = $Body | ConvertFrom-Json
                $ConfigText = [string]$Payload.configText
                $Reason = [string]$Payload.reason
                if ([string]::IsNullOrWhiteSpace($ConfigText)) {
                    throw "配置内容为空"
                }

                $BackupName = New-Backup -Reason $Reason
                $Utf8 = New-Object System.Text.UTF8Encoding($false)
                [System.IO.File]::WriteAllText($ConfigPath, $ConfigText, $Utf8)

                Send-Json $Context ([PSCustomObject]@{
                    ok = $true
                    saved = $ConfigPath
                    backup = $BackupName
                    time = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
                })
            } catch {
                Send-Json $Context ([PSCustomObject]@{ ok = $false; error = $_.Exception.Message }) 500
            }
            continue
        }

        if ($Path -eq "/api/backups") {
            Send-Json $Context ([PSCustomObject]@{ ok = $true; items = (Get-BackupList) })
            continue
        }

        if ($Path -eq "/api/restore-backup" -and $Request.HttpMethod -eq "POST") {
            try {
                $Body = Read-Body $Request
                $Payload = $Body | ConvertFrom-Json
                $Name = [System.IO.Path]::GetFileName([string]$Payload.name)
                $Source = Join-Path $BackupDir $Name

                if (-not (Test-Path -LiteralPath $Source)) {
                    throw "找不到指定备份"
                }

                $Safety = New-Backup -Reason "恢复前安全备份"
                Copy-Item -LiteralPath $Source -Destination $ConfigPath -Force

                Send-Json $Context ([PSCustomObject]@{
                    ok = $true
                    restored = $Name
                    safetyBackup = $Safety
                })
            } catch {
                Send-Json $Context ([PSCustomObject]@{ ok = $false; error = $_.Exception.Message }) 500
            }
            continue
        }

        if ($Path -eq "/api/delete-backup" -and $Request.HttpMethod -eq "POST") {
            try {
                $Body = Read-Body $Request
                $Payload = $Body | ConvertFrom-Json
                $Name = [System.IO.Path]::GetFileName([string]$Payload.name)
                $Target = Join-Path $BackupDir $Name
                if (Test-Path -LiteralPath $Target) {
                    Remove-Item -LiteralPath $Target -Force
                }
                Send-Json $Context ([PSCustomObject]@{ ok = $true })
            } catch {
                Send-Json $Context ([PSCustomObject]@{ ok = $false; error = $_.Exception.Message }) 500
            }
            continue
        }

        # Static file serving
        if ($Path -eq "/") {
            $Path = "/" + [Uri]::EscapeDataString("教师版.html")
        }

        $Relative = $Path.TrimStart("/") -replace "/", [System.IO.Path]::DirectorySeparatorChar
        $Candidate = [System.IO.Path]::GetFullPath((Join-Path $Root $Relative))
        $RootFull = [System.IO.Path]::GetFullPath($Root)

        if (-not $Candidate.StartsWith($RootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
            Send-Text $Context "Forbidden" "text/plain; charset=utf-8" 403
            continue
        }

        if (Test-Path -LiteralPath $Candidate -PathType Leaf) {
            $Bytes = [System.IO.File]::ReadAllBytes($Candidate)
            Send-Bytes $Context $Bytes (Get-MimeType $Candidate) 200
        } else {
            Send-Text $Context "Not Found" "text/plain; charset=utf-8" 404
        }
    } catch {
        try {
            Send-Json $Context ([PSCustomObject]@{ ok = $false; error = $_.Exception.Message }) 500
        } catch {}
    }
}
