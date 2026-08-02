# OffdisVM bridge: persistent PowerShell host for the VirtualBox Main API (COM).
# Speaks newline-delimited JSON over stdin/stdout. Keep this process alive for
# the whole CLI session so VirtualBox.Session locks survive between commands.

$ErrorActionPreference = 'Stop'
try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    [Console]::InputEncoding = [System.Text.Encoding]::UTF8
} catch { }

$script:vbox = $null
$script:session = $null
$script:sessionVM = $null

$script:stateNames = @{
    0  = 'Null'; 1 = 'PoweredOff'; 2 = 'Saved'; 3 = 'Teleported'; 4 = 'Aborted';
    5  = 'Running'; 6 = 'Paused'; 7 = 'Stuck'; 8 = 'Starting'; 9 = 'Stopping';
    10 = 'Saving'; 11 = 'Restoring'; 12 = 'Teleporting'; 13 = 'TeleportingIn';
    14 = 'TeleportingOut'; 15 = 'Snapshotting'; 16 = 'Discarding'; 17 = 'Creating';
    18 = 'DeletingOnline'; 19 = 'DeletingSnapshotOnline'; 20 = 'DeletingSnapshotPowersOff';
}

$script:vboxManage = 'C:\Program Files\Oracle\VirtualBox\VBoxManage.exe'

# COM sometimes reports "Paused" for VMs that are actually running (VBoxSVC quirk).
# Cross-check with VBoxManage showvminfo and prefer its verdict.
function Get-RealStateName($name) {
    try {
        if (-not (Test-Path $script:vboxManage)) { return $null }
        $out = & $script:vboxManage showvminfo $name --machinereadable 2>$null
        foreach ($l in $out) {
            if ($l -like 'VMState=*') {
                return $l.Substring(8).Trim('"').Trim()
            }
        }
    } catch { }
    return $null
}

function ConvertTo-ComState($realName) {
    switch ($realName) {
        'running'            { return 5 }
        'paused'             { return 6 }
        'poweroff'           { return 1 }
        'poweredoff'         { return 1 }
        'saved'              { return 2 }
        'aborted'            { return 4 }
        'gurumeditation'     { return 7 }
        'starting'           { return 8 }
        'stopping'           { return 9 }
        'saving'             { return 10 }
        'restoring'          { return 11 }
        'teleporting'        { return 12 }
        'teleportingin'      { return 13 }
        'teleportingout'     { return 14 }
        'snapshotting'       { return 15 }
        'discarding'         { return 16 }
        'creating'           { return 17 }
        'deletingonline'     { return 18 }
        default              { return $null }
    }
}

function Resolve-State($comState, $name) {
    $realName = Get-RealStateName $name
    if (-not [string]::IsNullOrEmpty($realName)) {
        $com = ConvertTo-ComState $realName
        if ($null -ne $com) {
            return [PSCustomObject]@{ state = $com; stateName = $script:stateNames[$com]; realName = $realName }
        }
    }
    return [PSCustomObject]@{ state = $comState; stateName = $script:stateNames[$comState]; realName = $null }
}

function Send-Json($obj) {
    $line = 'null'
    if ($null -ne $obj) {
        try { $line = $obj | ConvertTo-Json -Compress -Depth 12 } catch { $line = 'null' }
    }
    [Console]::Out.WriteLine($line)
    [Console]::Out.Flush()
}

function Get-VBox {
    if ($null -eq $script:vbox) {
        $script:vbox = New-Object -ComObject VirtualBox.VirtualBox
    }
    return $script:vbox
}

function Close-Session {
    if ($null -ne $script:session) {
        try { $script:session.UnlockMachine() | Out-Null } catch { }
        try { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($script:session) | Out-Null } catch { }
        $script:session = $null
        $script:sessionVM = $null
    }
}

function Get-Machines {
    $vbox = Get-VBox
    $arr = @()
    foreach ($m in @($vbox.Machines)) {
        try {
            $st = [int]$m.State
            $name = [string]$m.Name
            if ([string]::IsNullOrEmpty($name)) { $name = '<inaccessible>' }
            $resolved = Resolve-State $st $name
            $arr += [PSCustomObject]@{
                name      = $name
                id        = [string]$m.Id
                state     = $resolved.state
                stateName = $resolved.stateName
                realName  = $resolved.realName
            }
        } catch {
            $arr += [PSCustomObject]@{ name = '<unreadable>'; id = ''; state = -1; stateName = 'Error'; realName = $null }
        }
    }
    return ,$arr
}

function Select-Machine($name) {
    if ([string]::IsNullOrWhiteSpace($name)) { throw 'usage: use <vm name>' }
    Close-Session
    $machine = (Get-VBox).FindMachine($name)
    $st = [int]$machine.State
    $s = New-Object -ComObject VirtualBox.Session
    $machine.LockMachine($s, 1)
    $script:session = $s
    $script:sessionVM = $name
    $resolved = Resolve-State $st $name
    return [PSCustomObject]@{ name = $name; state = $resolved.state; stateName = $resolved.stateName; realName = $resolved.realName; locked = $true }
}

function Start-Machine($name) {
    if ([string]::IsNullOrWhiteSpace($name)) { throw 'usage: start <vm name>' }
    Close-Session
    $machine = (Get-VBox).FindMachine($name)
    $st = [int]$machine.State
    $s = New-Object -ComObject VirtualBox.Session
    if ($st -eq 1 -or $st -eq 2 -or $st -eq 4) {
        # PowerShell COM binding cannot marshal LaunchVMProcess (DISP_E_TYPEMISMATCH),
        # so launch via VBoxManage and keep the Main API for everything else.
        if (-not (Test-Path $script:vboxManage)) { throw 'VBoxManage not found - cannot start VM' }
        $out = & $script:vboxManage startvm $name --type gui 2>&1
        if ($LASTEXITCODE -ne 0) { throw "VBoxManage startvm failed: $($out -join ' ')" }
        for ($i = 0; $i -lt 30; $i++) {
            $real = Get-RealStateName $name
            if ($real -in @('running', 'starting', 'paused', 'saving')) { break }
            Start-Sleep -Milliseconds 500
        }
    }
    $locked = $false
    for ($i = 0; $i -lt 20; $i++) {
        try {
            $machine.LockMachine($s, 1)
            $locked = $true
            break
        } catch {
            Start-Sleep -Milliseconds 500
        }
    }
    if (-not $locked) { throw 'could not lock session after start' }
    $script:session = $s
    $script:sessionVM = $name
    $resolved = Resolve-State $st $name
    return [PSCustomObject]@{ name = $name; state = $resolved.state; stateName = $resolved.stateName; realName = $resolved.realName; locked = $true }
}

function Get-Info($name) {
    if ([string]::IsNullOrWhiteSpace($name)) { throw 'usage: info <vm name>' }
    $machine = (Get-VBox).FindMachine($name)
    $st = [int]$machine.State
    $snap = ''
    try { $snap = [string]$machine.CurrentSnapshot.Name } catch { }
    $resolved = Resolve-State $st $name
    return [PSCustomObject]@{
        name      = [string]$machine.Name
        id        = [string]$machine.Id
        state     = $resolved.state
        stateName = $resolved.stateName
        realName  = $resolved.realName
        memoryMB  = [int]$machine.MemorySize
        vcpu      = [int]$machine.CPUCount
        os        = [string]$machine.OSTypeId
        snapshot  = $snap
    }
}

function Assert-ActiveSession {
    if ($null -eq $script:session -or $null -eq $script:sessionVM) {
        throw 'no active VM - use `use <name>` or `start <name>` first'
    }
    $comState = [int]((Get-VBox).FindMachine($script:sessionVM).State)
    $resolved = Resolve-State $comState $script:sessionVM
    $st = $resolved.state
    if ($st -notin @(5, 6, 8)) {
        throw "VM is $($resolved.stateName) - start it first"
    }
}

function Invoke-Key($codes) {
    Assert-ActiveSession
    $kbd = $script:session.Console.Keyboard
    $kbd.putScancodes([int[]]$codes) | Out-Null
    return $true
}

# Paces whole groups of scancodes internally with a delay between groups,
# avoiding a PowerShell RPC round-trip per character while keeping the
# inter-key gap that prevents VirtualBox keyboard-buffer overruns.
function Invoke-Type($groups, $delayMs) {
    Assert-ActiveSession
    $kbd = $script:session.Console.Keyboard
    $delay = [int]$delayMs
    foreach ($g in $groups) {
        $kbd.putScancodes([int[]]$g) | Out-Null
        if ($delay -gt 0) { Start-Sleep -Milliseconds $delay }
    }
    return $true
}

function Invoke-Pause  { Assert-ActiveSession; $script:session.Console.Pause() | Out-Null; return $true }
function Invoke-Resume { Assert-ActiveSession; $script:session.Console.Resume() | Out-Null; return $true }
function Invoke-PowerOff { Assert-ActiveSession; $script:session.Console.PowerDown() | Out-Null; return $true }

# Gracefully powers off the active VM and waits until it is fully stopped.
function Stop-And-Wait($name) {
    if ([string]::IsNullOrWhiteSpace($name)) { throw 'no active VM - use start <name> first' }
    Close-Session
    $machine = (Get-VBox).FindMachine($name)
    $st = [int]$machine.State
    if ($st -in @(5, 6, 8)) {
        $s = New-Object -ComObject VirtualBox.Session
        $machine.LockMachine($s, 1)
        try {
            $s.Console.PowerDown() | Out-Null
            $s.UnlockMachine() | Out-Null
        } catch {
            try { $s.UnlockMachine() | Out-Null } catch { }
        }
    }
    for ($i = 0; $i -lt 60; $i++) {
        $real = Get-RealStateName $name
        if ($real -in @('poweroff', 'saved', 'aborted')) { return }
        Start-Sleep -Milliseconds 500
    }
    throw "VM $name did not power off in time"
}

function Invoke-Restart {
    $name = $script:sessionVM
    Stop-And-Wait $name
    return Start-Machine $name
}

function Invoke-Revert {
    $name = $script:sessionVM
    if ([string]::IsNullOrWhiteSpace($name)) { throw 'no active VM - use start <name> first' }
    $machine = (Get-VBox).FindMachine($name)
    if ($null -eq $machine.CurrentSnapshot) { throw 'VM has no snapshots to revert to' }
    if (-not (Test-Path $script:vboxManage)) { throw 'VBoxManage not found - cannot revert' }
    Stop-And-Wait $name
    $out = & $script:vboxManage snapshot $name restorecurrent 2>&1
    if ($LASTEXITCODE -ne 0) { throw "VBoxManage snapshot restore failed: $($out -join ' ')" }
    return Start-Machine $name
}

# ---- handshake ----
try {
    $vbox = Get-VBox
    Send-Json ([PSCustomObject]@{
        id   = 0
        ok   = $true
        result = [PSCustomObject]@{
            ready       = $true
            version     = [string]$vbox.Version
            apiRevision = [string]$vbox.APIRevision
        }
    })
} catch {
    Send-Json ([PSCustomObject]@{ id = 0; ok = $false; error = $_.Exception.Message })
    exit 1
}

# ---- request loop ----
while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    $req = $null
    try { $req = $line | ConvertFrom-Json } catch { }
    if ($null -eq $req) {
        Send-Json ([PSCustomObject]@{ id = -1; ok = $false; error = 'invalid JSON request' })
        continue
    }
    $id = $req.id
    $op = [string]$req.op
    if ($op -eq 'exit') {
        Close-Session
        Send-Json ([PSCustomObject]@{ id = $id; ok = $true; result = $true })
        break
    }
    try {
        $result = $null
        switch ($op) {
            'listMachines' { $result = Get-Machines }
            'select'       { $result = Select-Machine ([string]$req.args.name) }
            'start'        { $result = Start-Machine ([string]$req.args.name) }
            'info'         { $result = Get-Info ([string]$req.args.name) }
            'key'          { $result = Invoke-Key ($req.args.codes) }
            'type'         { $result = Invoke-Type ($req.args.groups) ($req.args.delay) }
            'pause'        { $result = Invoke-Pause }
            'resume'       { $result = Invoke-Resume }
            'stop'         { $result = Invoke-PowerOff }
            'restart'      { $result = Invoke-Restart }
            'revert'       { $result = Invoke-Revert }
            'unlock'       { Close-Session; $result = $true }
            'active'       { $result = $script:sessionVM }
            default        { throw "unknown op: $op" }
        }
        Send-Json ([PSCustomObject]@{ id = $id; ok = $true; result = $result })
    } catch {
        Send-Json ([PSCustomObject]@{ id = $id; ok = $false; error = $_.Exception.Message })
    }
}
Close-Session
