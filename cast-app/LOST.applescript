property startedAt : 0
property appDir : ""

on portNumber()
	try
		return do shell script "grep -o '\"port\": *[0-9]*' " & quoted form of (appDir & "/config.json") & " | grep -o '[0-9]*$'"
	on error
		return "8765"
	end try
end portNumber

on run
	set here to POSIX path of (path to me)
	set appDir to (do shell script "dirname " & quoted form of here) & "/cast-app"
	set startedAt to (do shell script "date +%s") as integer
	-- уже запущено? тогда второй раз не стартуем
	try
		do shell script "curl -s -m 2 --fail -o /dev/null http://localhost:" & (my portNumber()) & "/__ping"
		set startedAt to 0
		return
	end try
	do shell script "cd " & quoted form of appDir & " && nohup ./start.command >/tmp/lost-start.log 2>&1 &"
end run

-- Исходник LOST.app (компилируется в LOST.app/Contents/Resources/Scripts/main.scpt: см. PORTING.md).
-- Обычно значок закрывает сама программа при выходе (start.js → quit). Здесь — редкая страховка на случай её падения:
-- проверка раз в минуту, а не каждые 4 с (на Mac mini 2014 частый опрос держал ~15 % CPU).
on idle
	try
		set nowT to (do shell script "date +%s") as integer
		if startedAt is not 0 and nowT - startedAt > 25 then
			do shell script "curl -s -m 2 --fail -o /dev/null http://localhost:" & (my portNumber()) & "/__ping"
		end if
	on error
		quit
	end try
	return 60
end idle

-- ⌘Q / «Завершить» в Dock: остановить всю программу (таймер, терминал, сервер)
on quit
	try
		do shell script "curl -s -m 3 http://localhost:" & (my portNumber()) & "/__quit"
	end try
	continue quit
end quit

