$ErrorActionPreference = "Stop"
$projectDir = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $projectDir ".env.local"
$settings = @{}
Get-Content -LiteralPath $envFile | ForEach-Object {
    if ($_ -match '^([A-Z0-9_]+)=(.*)$') { $settings[$matches[1]] = $matches[2].Trim() }
}
$cliPath = Join-Path $projectDir "node_modules\@cloudbase\cli\bin\tcb"

Write-Host "`n请设置辅导员工作台密码（输入时屏幕不会显示字符，这是正常的）" -ForegroundColor Cyan
Write-Host "要求：8到32位，并同时包含大写字母、小写字母、数字、特殊符号中的至少3类。`n"
$firstSecure = Read-Host "输入新密码" -AsSecureString
$secondSecure = Read-Host "再输入一次" -AsSecureString
$firstPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($firstSecure)
$secondPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secondSecure)

try {
    $first = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($firstPtr)
    $second = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secondPtr)
    if ($first -cne $second) { throw "两次输入不一致，请重新运行此脚本。" }
    $categories = 0
    if ($first -cmatch '[A-Z]') { $categories++ }
    if ($first -cmatch '[a-z]') { $categories++ }
    if ($first -match '[0-9]') { $categories++ }
    if ($first -match '[^A-Za-z0-9]') { $categories++ }
    if ($first.Length -lt 8 -or $first.Length -gt 32 -or $categories -lt 3) { throw "密码不符合上面的长度或复杂度要求，请重新运行此脚本。" }

    & node $cliPath user update $settings.ADMIN_UID -e $settings.CLOUDBASE_ENV_ID --password $first --status ACTIVE --json
    if ($LASTEXITCODE -ne 0) { throw "CloudBase 没有接受这次密码设置。" }
    Write-Host "`n辅导员密码设置成功。用户名固定为：counselor" -ForegroundColor Green
} finally {
    $first = $null
    $second = $null
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($firstPtr)
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secondPtr)
}
