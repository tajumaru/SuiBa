' POTARIO Bot hidden-window launcher wrapper (for Task Scheduler).
' When Task Scheduler runs a .cmd directly in an interactive session,
' a console window stays on screen for the bot's whole lifetime.
' Going through wscript with window style 0 (hidden) starts the same
' launcher with no window at all. The launch itself (cd, log append)
' stays in pc-bot-launcher.cmd; this file only hides the window.
Option Explicit
Dim sh, fso, dir
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run "cmd /d /c """ & dir & "\pc-bot-launcher.cmd""", 0, False
