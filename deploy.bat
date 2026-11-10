@echo off
chcp 65001 >nul
title ProSewa - Deploy
cd /d "%~dp0"
echo ============================================
echo   ProSewa - Deploy Rules + Functions
echo   Projek: kukusanmy  ^|  Database: prosewa
echo ============================================
echo.

where git >nul 2>nul || (echo [X] Git tiada. Install dari https://git-scm.com & pause & exit /b 1)
where node >nul 2>nul || (echo [X] Node.js tiada. Install dari https://nodejs.org ^(versi LTS^) & pause & exit /b 1)

echo [1/5] Tarik kod terbaru dari GitHub...
git pull
if errorlevel 1 (echo [X] git pull gagal. Pastikan folder ini ialah repo ProSewa. & pause & exit /b 1)

echo.
echo [2/5] Semak Firebase CLI...
where firebase >nul 2>nul
if errorlevel 1 (
  echo Firebase CLI tiada - memasang...
  call npm install -g firebase-tools
)
call firebase projects:list >nul 2>nul
if errorlevel 1 (
  echo Sila log masuk Firebase dalam browser...
  call firebase login
)

echo.
echo [3/5] Pasang pakej functions...
pushd functions
call npm install --no-audit --no-fund
popd

echo.
echo [4/5] Deploy Firestore Rules ke database "prosewa" SAHAJA...
call firebase deploy --only firestore:rules --project kukusanmy
if errorlevel 1 (echo [X] Deploy rules gagal. & pause & exit /b 1)

echo.
echo [5/5] Deploy Cloud Functions ProSewa...
echo.
echo   *** PENTING: Jika ditanya "delete" function lain (KUKUSAN), taip N lalu Enter ***
echo.
call firebase deploy --only functions:prosewa --project kukusanmy
if errorlevel 1 (echo [X] Deploy functions gagal. Screenshot ralat di atas. & pause & exit /b 1)

echo.
echo ============================================
echo   SIAP! Rules + Functions ProSewa sudah deploy.
echo ============================================
pause
