# 🚌 Mi Pase TNE · Valparaíso

Aplicación móvil (**APK Android + Web**) de billetera estudiantil sincronizada con el **Validador Electrónico Independiente en Cabina (IDEA-07 / PR-03)** para el transporte público licitado del Gran Valparaíso.

Proyecto desarrollado en la asignatura **Ingeniería, Innovación y Emprendimiento (IIE)** — Facultad de Ingeniería, **Universidad de Valparaíso (UV)**, Chile.

---

## 🎯 Problema que aborda

Los estudiantes de educación superior y enseñanza media del Gran Valparaíso enfrentan omisión de paradas, hostilidad verbal y riesgo físico al abordar microbuses debido al sistema de recaudo manual en efectivo de la tarifa escolar (`$200 CLP`).

**Mi Pase TNE** desintermedia el cobro manual del conductor permitiendo validar la tarifa escolar en menos de 1 segundo mediante un validador electrónico independiente instalado en cabina (**Arduino UNO R4 WiFi + lector RFID RC522 + pantallas LCD 16x2 y OLED 128x64**).

---

## ✨ Funcionalidades implementadas

* **Cuentas individuales y saldo compartido:** Registro e inicio de sesión por estudiante, vinculando un código único de tarjeta TNE (`UID`) sincronizado en tiempo real con Supabase.
* **Validación sin contacto (TNE física o celular Android):**
  * **Con TNE física:** Al acercar la credencial al lector RC522 del validador, se descuenta la tarifa escolar (`-$200 CLP`), se enciende el LED verde, la pantalla OLED muestra un check (`✓`) y el teléfono vinculado recibe la confirmación visual y sonora en menos de 1,5 segundos.
  * **Con celular Android (APK nativa):** Lectura de tarjetas TNE físicas mediante `NfcAdapter.enableReaderMode` (con `FLAG_READER_SKIP_NDEF_CHECK` para tarjetas Mifare Classic) y emulación **HCE (`HostApduService`)** para interactuar con el validador.
* **Préstamo Escolar de Emergencia ("Pasaje al Fiado"):** Permite activar 1 pasaje de emergencia (`-$200 CLP`) cuando el saldo baja de `$200`, descontándose automáticamente en la siguiente recarga.
* **Recarga de saldo y control de gastos:** Recargas rápidas (`+$1.000`, `+$2.000`, `+$5.000` o monto personalizado mínimo `$200`), historial de movimientos por sector de abordaje en el Gran Valparaíso y cálculo del ahorro estudiantil respecto a la tarifa adulta (**Ley 20.378**).
* **Accesibilidad y confort:** Modo oscuro/claro persistente, opción para ocultar el saldo en pantalla (`$ ••••••`), vibración háptica, tonos diferenciados y bloqueo anti-doble cobro de 3 segundos.

---

## 📱 Versión Web vs. APK Android

| Capacidad | Versión Web (GitHub Pages) | APK Android (Capacitor + NFC Nativo) |
| :--- | :---: | :---: |
| Registro e inicio de sesión | ✅ (Ingreso manual de UID) | ✅ (Lectura NFC de TNE o manual) |
| Consulta de saldo y recargas simuladas | ✅ | ✅ |
| Pago desde botón en pantalla | ✅ | ✅ |
| Lectura de TNE física (Mifare Classic) detrás del celular | ⚠️ Limitado (Chrome Web NFC solo lee NDEF) | ✅ Nativo (`ReaderMode`) |
| Pago acercando el celular al lector RC522 (HCE) | ❌ No soportado por navegadores | ✅ Nativo (`TneHceService`) |

* **Demo Web:** [https://umatiov.github.io/AppUVMicro/](https://umatiov.github.io/AppUVMicro/)
* **Descargar APK Android:** Disponible automáticamente en la pestaña **Actions** → última ejecución verde de *Compilar APK Mi Pase TNE* → **Artifacts (`Mi-Pase-TNE-APK`)**.

---

## 🗂️ Estructura del repositorio

```text
AppUVMicro/
├── index.html                  # Estructura HTML5 de la billetera
├── styles.css                  # Estilos visuales, tema oscuro y animaciones
├── app.js                      # Lógica de cuentas, Supabase, polling y puente NFC
├── config.json                 # Parámetros de tarifas, sectores y validadores
├── manifest.json               # Configuración base de aplicación web
├── www/                        # Copia de recursos web empaquetados por Capacitor
├── android/                    # Proyecto nativo Android (MainActivity.java y TneHceService.java)
└── .github/workflows/
    └── build-apk.yml           # Compilación automática del instalador .apk en GitHub Actions