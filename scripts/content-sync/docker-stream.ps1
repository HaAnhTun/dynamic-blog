# Moves bytes through `docker exec -i` instead of `docker cp` (dot-sourced by export-content.ps1, import-content.ps1 and selftest.ps1).
#
# The postgres container of the compose file is read-only (a tmpfs at /tmp and nothing else writable): `docker cp` into it fails with
# "container rootfs is marked read-only", and `docker cp` out of it cannot see a file that `docker exec` wrote to the tmpfs. So a file
# goes in on the standard input of the command that uses it (psql -f -, pg_restore, pg_restore -l) and comes out on its standard
# output (pg_dump -Fc), and nothing is staged in the container at all.
#
# The streams are copied as bytes with .NET: the pipeline of Windows PowerShell and of PowerShell before 7.4 decodes a native command's
# output as text and would damage a custom-format dump.

function Invoke-DockerStream {
    <#
    .SYNOPSIS
      Runs `docker <DockerArgs>`, optionally feeding a file to its standard input and saving its standard output to a file.
    .OUTPUTS
      An object with ExitCode, Stdout (text, only when no -OutFile) and Stderr (text).
    #>
    param(
        [Parameter(Mandatory)][string[]]$DockerArgs,
        # A file whose bytes are sent to the standard input of the command (it must run with `exec -i`).
        [string]$InFile = '',
        # A file that receives the bytes of the standard output. Without it the output is returned as text.
        [string]$OutFile = '',
        # The program to run; only the unit test of this helper changes it.
        [string]$Program = 'docker'
    )
    $info = [Diagnostics.ProcessStartInfo]::new($Program)
    foreach ($argument in $DockerArgs) { $info.ArgumentList.Add($argument) }
    $info.UseShellExecute = $false
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $process = [Diagnostics.Process]::Start($info)
    $outStream = $null
    try {
        # Both output streams are drained at once so that a full pipe never blocks the command while the input is still being written.
        $errTask = $process.StandardError.ReadToEndAsync()
        if ($OutFile -ne '') {
            $outStream = [IO.File]::Create($OutFile)
            $outTask = $process.StandardOutput.BaseStream.CopyToAsync($outStream)
        } else {
            $outTask = $process.StandardOutput.ReadToEndAsync()
        }
        $input = $process.StandardInput.BaseStream
        try {
            if ($InFile -ne '') {
                $source = [IO.File]::OpenRead($InFile)
                try { $source.CopyTo($input) } finally { $source.Dispose() }
            }
            $input.Flush()
        } catch [IO.IOException] {
            # The command ended before it read everything (a refusal, a missing container): its exit code and stderr say why.
        } finally {
            try { $input.Dispose() } catch [IO.IOException] { }
        }
        $process.WaitForExit()
        $outTask.GetAwaiter().GetResult() | Out-Null
        $stdout = if ($OutFile -eq '') { [string]$outTask.Result } else { '' }
        return [pscustomobject]@{ ExitCode = $process.ExitCode; Stdout = $stdout; Stderr = $errTask.GetAwaiter().GetResult() }
    } finally {
        if ($outStream) { $outStream.Dispose() }
        $process.Dispose()
    }
}
