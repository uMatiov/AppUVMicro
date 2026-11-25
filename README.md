# 🚌 Mi Pase TNE · Valparaíso (`AppUVMicro`)

Aplicación web progresiva (PWA) de billetera estudiantil sincronizada en tiempo real con el **Validador Electrónico Independiente en Cabina (IDEA-07 / PR-03)** para el transporte público licitado del Gran Valparaíso.

🔗 **Demo en vivo (GitHub Pages):** [https://umatiov.github.io/AppUVMicro/](https://umatiov.github.io/AppUVMicro/)

---

## 🎯 Propósito del Proyecto

Este sistema busca desintermediar el pago manual de la tarifa escolar ($200 CLP) frente al conductor en los microbuses del Gran Valparaíso, erradicando la fricción relacional (`H-01`, `INS-02`) y permitiendo un abordaje fluido, digno y con ambas manos libres para afirmarse en el pasamanos (`H-04`, `NEC-01`, `NEC-02`).

Proyecto alineado con la **Ley 20.378** (Subsidio Nacional al Transporte Público), el **Eje 3 de la ERD Valparaíso** y el **ODS 11 (Meta 11.2)**.

---

## ✨ Funcionalidades Principales de la App

* **💳 Saldo Compartido en Tiempo Real:** Sincronización instantánea entre la tarjeta TNE física y la billetera móvil mediante **Supabase**.
* **📡 Vinculación y Lectura sin Contacto (Web NFC):** Guía visual interactiva de 2 pasos para vincular o cambiar la tarjeta TNE física acercándola al reverso del teléfono (compatible con Google Chrome en Android).
* **✅ Confirmación Multisensorial (< 1 s):** Pantalla completa de validación aprobada/rechazada con retroalimentación sonora (`AudioContext`), vibración háptica y bloqueo anti-doble cobro de 3 segundos.
* **🆘 Préstamo Escolar de Emergencia ("Pasaje al Fiado"):** Permite 1 viaje de emergencia (`-$200 CLP`) cuando el estudiante se queda sin saldo, descontándose automáticamente en la siguiente recarga.
* **🔒 Seguridad y Bloqueo por Extravío:** Congelamiento temporal del pase en un toque para proteger el saldo ante pérdida o robo.
* **🌙 Modo Oscuro y Privacidad:** Tema nocturno adaptable para viajes de noche y ocultación de saldo en pantalla (`$ ••••••`).

---

## 🛠️ Arquitectura del Sistema (Hardware + Software)

### 1. Estructura Modular Frontend (PWA)
* `index.html`: Interfaz móvil de 5 vistas (*Saldo, Pagar, Recarga, Historial y Cuenta*).
* `styles.css`: Sistema de diseño adaptable con soporte *Dark Mode* y animaciones vectoriales CSS.
* `app.js`: Lógica de sincronización REST/RPC con Supabase, lectura `NDEFReader` (Web NFC) y gestión de estado local.
* `config.json` & `manifest.json`: Parámetros tarifarios, sectores del Gran Valparaíso e instalación como aplicación móvil.

### 2. Hardware del Validador en Cabina (`Arduino UNO R4 WiFi`)
* **Microcontrolador:** Arduino UNO R4 WiFi (conectividad HTTPS hacia Supabase).
* **Lector sin contacto:** Módulo RFID/NFC `MFRC522` (13.56 MHz a `3.3V`).
* **Pantallas en Cabina:**
  * `LCD 16x2 I2C (0x20)`: Muestra `Tarifa: $200` en espera y el descuento + saldo restante al validar.
  * `OLED 128x64 I2C (0x3C)`: Despliega iconografía pura de alto contraste (Ondas NFC en espera, Check `✓` en aprobación y Cruz `✕` en rechazo).
* **Actuadores:** Indicadores luminosos LED Verde (Pin 2), LED Rojo (Pin 3) y Buzzer sonoro (Pin 4).

---

## 👥 Equipo de Desarrollo
**Ingeniería, Innovación y Emprendimiento (IIE)**
* Vicente Bassa
* Matías Pino
* Juan Pablo Castillo
* Benjamín Hernández
* Axel Álvarez
