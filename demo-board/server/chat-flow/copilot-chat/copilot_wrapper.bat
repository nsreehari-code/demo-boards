@echo off
setlocal enabledelayedexpansion

REM Copilot Wrapper - Minimal non-interactive wrapper around the current Copilot CLI
REM Usage: copilot_wrapper.bat <cwd> <prompt_file> <output_file> <err_file> [model] [continueSession]

SET "WORKING_DIR=%~1"
SET "PROMPT_FILE=%~2"
SET "OUTPUT_FILE=%~3"
SET "ERR_FILE=%~4"
SET "MODEL=%~5"
SET "CONTINUE_SESSION=%~6"

if not defined WORKING_DIR exit /b 2
if not defined PROMPT_FILE exit /b 2
if not defined OUTPUT_FILE exit /b 2
if not defined ERR_FILE exit /b 2

if not exist "%PROMPT_FILE%" (
    > "%ERR_FILE%" echo Prompt file not found: %PROMPT_FILE%
    exit /b 1
)

for %%I in ("%OUTPUT_FILE%") do if not exist "%%~dpI" mkdir "%%~dpI" >nul 2>&1
for %%I in ("%ERR_FILE%") do if not exist "%%~dpI" mkdir "%%~dpI" >nul 2>&1

SET "MODEL_FLAG="
if defined MODEL (
    SET "MODEL_FLAG=--model !MODEL!"
)

SET "CONTINUE_FLAG="
if /I "%CONTINUE_SESSION%"=="true" SET "CONTINUE_FLAG=--continue"
if /I "%CONTINUE_SESSION%"=="1" SET "CONTINUE_FLAG=--continue"
if /I "%CONTINUE_SESSION%"=="yes" SET "CONTINUE_FLAG=--continue"

type "%PROMPT_FILE%" | call copilot -C "%WORKING_DIR%" !CONTINUE_FLAG! -s --no-ask-user --allow-all-tools !MODEL_FLAG! >> "%OUTPUT_FILE%" 2> "%ERR_FILE%"
exit /b %ERRORLEVEL%

endlocal
