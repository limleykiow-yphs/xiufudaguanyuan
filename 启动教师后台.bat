@echo off
chcp 65001 >nul
title 梦回大观园 - 教师后台
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0启动教师后台.ps1"
