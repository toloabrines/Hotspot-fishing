@echo off
REM Script de configuración de secrets para GitHub Actions (Windows)
REM Este script te GUÍA para configurar los secrets correctamente
REM ⚠️  NO ejecutes este script directamente
REM Solo úsalo como referencia para configurar manualmente

echo.
echo ===============================================================
echo   GitHub Secrets Configuration Guide - Hotspot Fishing
echo ===============================================================
echo.

echo 📋 PASOS A SEGUIR (Manual):
echo.
echo 1️⃣  Abre GitHub en tu navegador:
echo    https://github.com/toloabrines/hotspot-fishing/settings/secrets/actions
echo.

echo 2️⃣  Haz clic en 'New repository secret'
echo.

echo 3️⃣  Crea estos 4 secrets:
echo.

echo ┌─────────────────────────────────────────────────────────┐
echo │ Secret #1: APPLE_ID                                     │
echo ├─────────────────────────────────────────────────────────┤
echo │ Name:  APPLE_ID                                         │
echo │ Value: tu_email@apple.com                               │
echo │                                                         │
echo │ Ejemplo: developer@company.com                          │
echo └─────────────────────────────────────────────────────────┘
echo.
pause

echo.
echo ┌─────────────────────────────────────────────────────────┐
echo │ Secret #2: APPLE_PASSWORD                               │
echo ├─────────────────────────────────────────────────────────┤
echo │ Name:  APPLE_PASSWORD                                   │
echo │ Value: xxxx-xxxx-xxxx-xxxx (app-specific)               │
echo │                                                         │
echo │ ⚠️  IMPORTANTE:                                          │
echo │ - Ir a: https://appleid.apple.com                       │
echo │ - Sign in con tu Apple ID                               │
echo │ - Security → App-specific passwords                     │
echo │ - Generate → Xcode o GitHub Actions                     │
echo │ - Copiar: xxxx-xxxx-xxxx-xxxx (sin espacios)            │
echo │ - NO es tu contraseña normal de Apple                   │
echo └─────────────────────────────────────────────────────────┘
echo.
pause

echo.
echo ┌─────────────────────────────────────────────────────────┐
echo │ Secret #3: APPLE_TEAM_ID                                │
echo ├─────────────────────────────────────────────────────────┤
echo │ Name:  APPLE_TEAM_ID                                    │
echo │ Value: XXXXXXXXXX (10 caracteres)                       │
echo │                                                         │
echo │ Cómo obtenerlo:                                         │
echo │ - Ir a: https://developer.apple.com/account             │
echo │ - Membership → Team ID                                  │
echo │ - Ejemplo: ABCD123456                                   │
echo └─────────────────────────────────────────────────────────┘
echo.
pause

echo.
echo ┌─────────────────────────────────────────────────────────┐
echo │ Secret #4: APPLE_ITC_TEAM_ID                            │
echo ├─────────────────────────────────────────────────────────┤
echo │ Name:  APPLE_ITC_TEAM_ID                                │
echo │ Value: 123456789 (numérico)                             │
echo │                                                         │
echo │ Cómo obtenerlo:                                         │
echo │ - Ir a: https://appstoreconnect.apple.com               │
echo │ - Tu nombre (arriba a la derecha)                       │
echo │ - Account Settings → Teams                              │
echo │ - Team ID (número)                                      │
echo └─────────────────────────────────────────────────────────┘
echo.
pause

echo.
echo ===============================================================
echo   ✅ TODOS LOS SECRETS CONFIGURADOS
echo ===============================================================
echo.
echo 📋 PRÓXIMO PASO:
echo.
echo 1. Ve a: GitHub Actions
echo 2. Selecciona: iOS Build and Upload to App Store
echo 3. Haz clic en: Run workflow
echo 4. Espera a que termine (5-10 minutos)
echo 5. Verifica TestFlight
echo.
echo ===============================================================
echo.
pause

