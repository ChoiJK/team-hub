@echo off
REM Usage: start-agent.bat <role> <project-dir> [persona] [project-rules]
REM
REM Examples:
REM   start-agent.bat coder D:\Workspace\EnglishLearningToolkit craftsman elt
REM   start-agent.bat designer D:\Workspace\EnglishLearningToolkit artist elt
REM   start-agent.bat reviewer D:\Workspace\rendering-engine guardian cpp-engine
REM   start-agent.bat researcher D:\Workspace\EnglishLearningToolkit explorer elt
REM
REM Profiles (profiles/ folder):
REM   Personas: craftsman, explorer, guardian, artist
REM   Roles:    coder, reviewer, designer, researcher, prototyper, pm, architect
REM   Rules:    default (always), elt, cpp-engine

if "%1"=="" (
    echo.
    echo   Usage: start-agent.bat ^<role^> ^<project-dir^> [persona] [project-rules]
    echo.
    echo   Roles:    pm, architect, coder, reviewer, designer, researcher, prototyper
    echo   Personas: craftsman, explorer, guardian, artist
    echo   Rules:    elt, cpp-engine
    echo.
    exit /b 1
)
if "%2"=="" (
    echo Please specify project directory
    exit /b 1
)

REM 환경변수 세팅
if "%AGENT_ID%"=="" set AGENT_ID=%1
if "%AGENT_ROLE%"=="" set AGENT_ROLE=%1
if "%TEAM_HUB_URL%"=="" set TEAM_HUB_URL=http://127.0.0.1:4000
if not "%3"=="" set AGENT_PERSONA=%3
if not "%4"=="" set PROJECT_RULES=%4

REM 프로젝트 이름 추출
for %%F in (%2) do set PROJECT=%%~nxF

echo.
echo   ========================================
echo     Agent:   %1
echo     Persona: %3
echo     Project: %PROJECT%
echo     Rules:   default + %4
echo     Dir:     %2
echo   ========================================
echo.

REM .mcp.json 복사
if not exist "%2\.mcp.json" (
    copy "%~dp0.mcp.json" "%2\.mcp.json" >nul
    echo   .mcp.json copied.
)

cd /d %2
claude --dangerously-load-development-channels server:team-hub --dangerously-skip-permissions
