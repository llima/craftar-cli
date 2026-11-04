# ci-sampler.ps1 - Temporary instrumentation to diagnose Windows CI timeout bursts.
# Records CPU, memory, pagefile, disk and process metrics during the test suite.
param(
    [Parameter(Mandatory=$true)]
    [ValidateSet('start','sample','report')]
    [string]$Mode,

    [string]$Out = (Join-Path $env:RUNNER_TEMP 'ci-sampler.csv'),

    [int]$Interval = 5
)

$ErrorActionPreference = 'SilentlyContinue'

function Start-Sampler {
    Write-Output '::group::Runner resources'
    try { Write-Output "NUMBER_OF_PROCESSORS: $env:NUMBER_OF_PROCESSORS" } catch { Write-Output 'NUMBER_OF_PROCESSORS: unknown' }
    try {
        $cs = Get-CimInstance Win32_ComputerSystem
        Write-Output "logical_processors: $($cs.NumberOfLogicalProcessors)"
        Write-Output "total_physical_memory_gb: $([math]::Round($cs.TotalPhysicalMemory / 1GB, 2))"
    } catch { Write-Output 'Win32_ComputerSystem: unknown' }
    try {
        $os = Get-CimInstance Win32_OperatingSystem
        Write-Output "free_physical_memory_mb: $([math]::Round($os.FreePhysicalMemory / 1024, 0))"
        Write-Output "total_virtual_memory_mb: $([math]::Round($os.TotalVirtualMemorySize / 1024, 0))"
        Write-Output "free_virtual_memory_mb: $([math]::Round($os.FreeVirtualMemory / 1024, 0))"
    } catch { Write-Output 'Win32_OperatingSystem: unknown' }
    try {
        $pf = Get-CimInstance Win32_PageFileUsage
        $pfAlloc = ($pf | Measure-Object -Property AllocatedBaseSize -Sum).Sum
        $pfCurr = ($pf | Measure-Object -Property CurrentUsage -Sum).Sum
        Write-Output "pagefile_allocated_mb: $pfAlloc"
        Write-Output "pagefile_current_mb: $pfCurr"
    } catch { Write-Output 'Win32_PageFileUsage: unknown' }
    try {
        $sysDrive = (Get-Item $env:SystemRoot).PSDrive.Name
        $sysDrv = Get-PSDrive $sysDrive
        Write-Output "system_drive_free_gb: $([math]::Round($sysDrv.Free / 1GB, 2))"
    } catch { Write-Output 'system_drive: unknown' }
    try {
        $tempDrive = (Get-Item $env:RUNNER_TEMP).PSDrive.Name
        $tempDrv = Get-PSDrive $tempDrive
        Write-Output "runner_temp_drive: $tempDrive"
        Write-Output "runner_temp_drive_free_gb: $([math]::Round($tempDrv.Free / 1GB, 2))"
    } catch { Write-Output 'runner_temp_drive: unknown' }
    try {
        $defender = Get-MpComputerStatus
        Write-Output "defender_realtime: $($defender.RealTimeProtectionEnabled)"
        Write-Output "defender_antivirus: $($defender.AntivirusEnabled)"
    } catch { Write-Output 'defender: unknown' }
    Write-Output '::endgroup::'

    $proc = Start-Process pwsh -ArgumentList '-NoProfile','-NonInteractive','-File',$PSCommandPath,'-Mode','sample','-Out',$Out,'-Interval',$Interval -WindowStyle Hidden -PassThru
    Set-Content -Path "$Out.pid" -Value $proc.Id
    exit 0
}

function Invoke-Sample {
    $header = 'time,cpu_pct,proc_queue,avail_mb,commit_pct,pagefile_mb,pages_per_s,disk_queue,disk_busy_pct,node,git,msmpeng_cpu_s'
    Set-Content -Path $Out -Value $header
    while ($true) {
        $row = @()
        try { $row += (Get-Date).ToUniversalTime().ToString('HH:mm:ss') } catch { $row += '' }
        try {
            $cpu = Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'"
            $row += $cpu.PercentProcessorTime
        } catch { $row += '' }
        try {
            $sys = Get-CimInstance Win32_PerfFormattedData_PerfOS_System
            $row += $sys.ProcessorQueueLength
        } catch { $row += '' }
        try {
            $mem = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory
            $row += $mem.AvailableMBytes
            $row += $mem.PercentCommittedBytesInUse
            $row += $mem.PagesPerSec
        } catch { $row += ''; $row += ''; $row += '' }
        try {
            $pf = Get-CimInstance Win32_PageFileUsage
            $row += ($pf | Measure-Object -Property CurrentUsage -Sum).Sum
        } catch { $row += '' }
        try {
            $disk = Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk -Filter "Name='_Total'"
            $row += $disk.CurrentDiskQueueLength
            $busy = [math]::Min($disk.PercentDiskTime, 100)
            $row += $busy
        } catch { $row += ''; $row += '' }
        try { $row += @(Get-Process -Name 'node' -ErrorAction SilentlyContinue).Count } catch { $row += '' }
        try { $row += @(Get-Process -Name 'git' -ErrorAction SilentlyContinue).Count } catch { $row += '' }
        try {
            $msmpeng = Get-Process -Name 'MsMpEng' -ErrorAction SilentlyContinue
            if ($msmpeng) {
                $row += [math]::Round($msmpeng.CPU, 0)
            } else {
                $row += ''
            }
        } catch { $row += '' }
        Add-Content -Path $Out -Value ($row -join ',')
        Start-Sleep -Seconds $Interval
    }
}

function Write-Report {
    $pidFile = "$Out.pid"
    if (Test-Path $pidFile) {
        try {
            $pid = Get-Content $pidFile
            Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
        } catch {}
    }
    if (Test-Path $Out) {
        $lines = Get-Content $Out
        $n = $lines.Count - 1
        Write-Output "::group::Runner samples ($n rows)"
        $lines | ForEach-Object { Write-Output $_ }
        Write-Output '::endgroup::'

        $data = $lines | Select-Object -Skip 1 | ForEach-Object {
            $cols = $_ -split ','
            [PSCustomObject]@{
                cpu_pct = if ($cols[1]) { [double]$cols[1] } else { $null }
                proc_queue = if ($cols[2]) { [double]$cols[2] } else { $null }
                avail_mb = if ($cols[3]) { [double]$cols[3] } else { $null }
                commit_pct = if ($cols[4]) { [double]$cols[4] } else { $null }
                pages_per_s = if ($cols[5]) { [double]$cols[5] } else { $null }
                disk_queue = if ($cols[7]) { [double]$cols[7] } else { $null }
                node = if ($cols[9]) { [int]$cols[9] } else { $null }
                git = if ($cols[10]) { [int]$cols[10] } else { $null }
            }
        }
        $maxCpu = ($data | Where-Object { $null -ne $_.cpu_pct } | Measure-Object -Property cpu_pct -Maximum).Maximum
        $maxQueue = ($data | Where-Object { $null -ne $_.proc_queue } | Measure-Object -Property proc_queue -Maximum).Maximum
        $minAvail = ($data | Where-Object { $null -ne $_.avail_mb } | Measure-Object -Property avail_mb -Minimum).Minimum
        $maxCommit = ($data | Where-Object { $null -ne $_.commit_pct } | Measure-Object -Property commit_pct -Maximum).Maximum
        $maxPages = ($data | Where-Object { $null -ne $_.pages_per_s } | Measure-Object -Property pages_per_s -Maximum).Maximum
        $maxDiskQ = ($data | Where-Object { $null -ne $_.disk_queue } | Measure-Object -Property disk_queue -Maximum).Maximum
        $maxNode = ($data | Where-Object { $null -ne $_.node } | Measure-Object -Property node -Maximum).Maximum
        $maxGit = ($data | Where-Object { $null -ne $_.git } | Measure-Object -Property git -Maximum).Maximum
        Write-Output "sampler: rows=$n max_cpu=$maxCpu max_queue=$maxQueue min_avail_mb=$minAvail max_commit_pct=$maxCommit max_pages_per_s=$maxPages max_disk_queue=$maxDiskQ max_node=$maxNode max_git=$maxGit"
    } else {
        Write-Output 'sampler: no samples'
    }
    exit 0
}

switch ($Mode) {
    'start'  { Start-Sampler }
    'sample' { Invoke-Sample }
    'report' { Write-Report }
}
