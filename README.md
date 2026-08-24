# So Italian Catering — Plataforma de cotizaciones

Formulario público con calculadora en vivo → Firestore → correo automático (Resend) → panel de seguimiento.

## Qué incluye

- `public/index.html` — formulario del cliente (menú, calculadora, datos de contacto)
- `public/admin.html` — panel del dueño (cotizaciones, estados, mensajes, menú editable)
- `functions/` — Cloud Functions que mandan los correos automáticos
- `firestore.rules` — reglas de seguridad

## Paso 1 — Crear el proyecto de Firebase

1. Andá a https://console.firebase.google.com → **Agregar proyecto** → nombralo `so-italian-catering` (o el que prefieras).
2. Dentro del proyecto: **Build → Firestore Database → Crear base de datos** (modo producción, región `us-central` o la más cercana a Guatemala).
3. **Build → Authentication → Comenzar → habilitar "Correo/contraseña"**. Después andá a la pestaña **Users** y creá tu propio usuario (tu correo + una contraseña) — con eso entrás al panel de administración.
4. **Project settings (⚙️) → General → tus apps → </> Agregar app web**. Copiá los valores que te da (`apiKey`, `authDomain`, etc.) y pegalos en `public/js/firebase-config.js`.
5. Este proyecto necesita el plan **Blaze** (pago por uso) para poder usar Cloud Functions — tiene una capa gratuita generosa; con el volumen de una academia/catering normalmente no pagás nada o casi nada.

## Paso 2 — Crear la cuenta de correo (Resend)

1. Creá una cuenta gratis en https://resend.com (tiene 3,000 correos/mes gratis).
2. Verificá tu dominio (o usá el dominio de prueba de Resend mientras configurás el tuyo).
3. Generá una **API Key** en Resend.
4. En `functions/index.js`, cambiá:
   - `FROM_EMAIL` por tu correo remitente verificado (ej. `"So Italian Catering <cotizaciones@soitaliancatering.com>"`)
   - `OWNER_EMAIL` por el correo donde querés recibir el aviso de cada cotización nueva

## Paso 3 — Instalar herramientas y conectar el proyecto

```bash
npm install -g firebase-tools
firebase login
cd so-italian-catering
firebase use --add        # elegí el proyecto que creaste en el Paso 1
```

## Paso 4 — Guardar la API Key de Resend de forma segura

```bash
firebase functions:secrets:set RESEND_API_KEY
```
(te va a pedir que pegues la key — no se guarda en el código)

## Paso 5 — Instalar dependencias y desplegar

```bash
cd functions
npm install
cd ..
firebase deploy
```

Esto publica el sitio (Hosting), las reglas (Firestore) y las 3 funciones de correo.
Al terminar, la terminal te da la URL pública, algo como:
`https://so-italian-catering.web.app`

- Formulario del cliente: `https://so-italian-catering.web.app/`
- Panel del dueño: `https://so-italian-catering.web.app/admin.html`

## Paso 6 — Cargar tu menú real

1. Entrá a `/admin.html` con el usuario que creaste.
2. Pestaña **Menú** → agregá cada platillo con categoría, nombre, precio por persona y descripción.
3. Automáticamente aparecen en el formulario del cliente.

## Cómo funciona el flujo completo

1. Cliente llena el formulario → se crea un documento en `cotizaciones` (Firestore).
2. Se dispara `onCotizacionCreated` → le manda al cliente el resumen con precio previo y le manda a vos el aviso de lead nuevo.
3. Vos entrás al panel, revisás la cotización, cambiás el estado (Nueva → Contactado → Cotización enviada → Cerrada/Perdida) — si querés, se le avisa al cliente por correo automáticamente.
4. Podés escribirle mensajes directo desde el panel; cada mensaje se le envía por correo también.

## Ideas para después (fase 2)

- Botón de "Aceptar cotización" en el correo del cliente que actualice el estado solo.
- Enlace de pago (anticipo) integrado en la cotización aprobada.
- Aviso a vos por WhatsApp (Green API, como ya usás en Move) además del correo, cuando entra un lead nuevo.
- Reportes de conversión (cuántas cotizaciones nuevas se cierran) en una vista dentro del mismo panel.
