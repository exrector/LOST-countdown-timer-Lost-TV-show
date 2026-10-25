property appDir : ""

on portNumber()
    try
        return do shell script "grep -o '\"port\": *[0-9]*' " & quoted form of (appDir & "/config.json") & " | grep -o '[0-9]*$'"
    on error
        return "8765"
    end try
end portNumber

on startStation()
    set here to POSIX path of (path to me)
    set appDir to (do shell script "dirname " & quoted form of here) & "/cast-app"
    try
        do shell script "curl -s -m 2 --fail -o /dev/null http://localhost:" & (my portNumber()) & "/__ping"
        return
    end try
    set target to "gui/" & (do shell script "id -u") & "/com.exrector.lost"
    try
        do shell script "/bin/launchctl kickstart " & quoted form of target
    on error
        -- Переносимая папка до установки службы: тот же процесс станции, без launchd.
        do shell script "cd " & quoted form of appDir & " && nohup ./start.command >/tmp/lost-start.log 2>&1 &"
    end try
end startStation

on run
    my startStation()
end run

on reopen
    my startStation()
end reopen

on idle
    -- Восстановлением ядра занимается launchd, окон — само ядро.
    return 60
end idle

on quit
    try
        do shell script "curl -s -m 3 http://localhost:" & (my portNumber()) & "/__quit"
    end try
    continue quit
end quit
