const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onCall } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

// Configurá estos "secrets" una sola vez desde la terminal (ver README):
//   firebase functions:secrets:set RESEND_API_KEY
const RESEND_API_KEY = defineSecret("RESEND_API_KEY");

// MODO DEMO: usando el dominio compartido de prueba de Resend.
// Con este dominio, Resend SOLO permite enviar correos a la dirección
// con la que te registraste en Resend (tu propio correo) — no a clientes
// reales todavía. Cuando tengas tu dominio propio, cambiá esta línea por
// algo como "So Italian Catering <cotizaciones@tudominio.com>" y verificá
// el dominio en Resend (Domains → Add Domain) para poder enviar a cualquiera.
const FROM_EMAIL = "So Italian Catering <onboarding@resend.dev>";

// Poné aquí el correo con el que te registraste en Resend — ahí es donde
// vas a recibir el aviso de "nueva cotización", y también el único correo
// al que le podés mandar la pre-cotización de prueba mientras estés en modo demo.
const OWNER_EMAIL = "movedancea@gmail.com";

async function enviarCorreo({ to, subject, html, apiKey }) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ from: FROM_EMAIL, to, subject, html })
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Resend error: ${res.status} ${errText}`);
  }
}

function fmtQ(n) {
  return `Q${Number(n || 0).toFixed(2)}`;
}

function itemsHtml(items, personas) {
  return (items || []).map(i =>
    `<tr><td style="padding:4px 8px;">${i.nombre} × ${i.cantidad}</td><td style="padding:4px 8px; text-align:right;">${fmtQ(i.precio * i.cantidad * personas)}</td></tr>`
  ).join("");
}

// ------------------------------------------------------------------
// 1. Se dispara automáticamente cuando un cliente envía el formulario.
//    Envía: (a) pre-cotización al cliente, (b) aviso a la dueña.
// ------------------------------------------------------------------
exports.onCotizacionCreated = onDocumentCreated(
  { document: "cotizaciones/{quoteId}", secrets: [RESEND_API_KEY] },
  async (event) => {
    const q = event.data.data();
    const apiKey = RESEND_API_KEY.value();

    const resumenHtml = `
      <div style="font-family:sans-serif; color:#2B2119;">
        <h2 style="color:#33482E;">So Italian Catering</h2>
        <p>Hola ${q.clienteNombre}, ¡gracias por tu interés! Este es un resumen previo de tu cotización:</p>
        <p><strong>Fecha del evento:</strong> ${q.fechaEvento}<br>
           <strong>Número de personas:</strong> ${q.numPersonas}</p>
        <table style="width:100%; border-collapse:collapse; margin:12px 0;">
          ${itemsHtml(q.items, q.numPersonas)}
          <tr><td style="padding:8px; font-weight:bold; border-top:2px solid #33482E;">Total estimado</td>
              <td style="padding:8px; font-weight:bold; text-align:right; border-top:2px solid #33482E;">${fmtQ(q.total)}</td></tr>
        </table>
        <p><strong>Este es un precio previo, no una confirmación final.</strong> Una persona de nuestro equipo se pondrá en contacto contigo pronto para confirmar todos los detalles.</p>
        <p>¡Gracias por pensar en nosotros para tu evento!</p>
      </div>
    `;

    await enviarCorreo({
      to: q.clienteEmail,
      subject: `Tu pre-cotización de catering — ${q.fechaEvento}`,
      html: resumenHtml,
      apiKey
    });

    const avisoHtml = `
      <div style="font-family:sans-serif;">
        <h3>Nueva cotización recibida</h3>
        <p><strong>${q.clienteNombre}</strong> — ${q.clienteEmail} — ${q.clienteTelefono}</p>
        <p>Evento: ${q.fechaEvento} · ${q.numPersonas} personas · Total: ${fmtQ(q.total)}</p>
        <p>Revisala en el panel de administración.</p>
      </div>
    `;

    await enviarCorreo({
      to: OWNER_EMAIL,
      subject: `Nueva cotización: ${q.clienteNombre} (${q.fechaEvento})`,
      html: avisoHtml,
      apiKey
    });
  }
);

// ------------------------------------------------------------------
// 2. Llamada desde el panel cuando la dueña manda un mensaje al cliente.
// ------------------------------------------------------------------
exports.sendMessageToClient = onCall(
  { secrets: [RESEND_API_KEY] },
  async (request) => {
    if (!request.auth) throw new Error("No autorizado");
    const { quoteId, texto, adjuntoUrl, adjuntoNombre } = request.data;

    const snap = await db.collection("cotizaciones").doc(quoteId).get();
    if (!snap.exists) throw new Error("Cotización no encontrada");
    const q = snap.data();

    const adjuntoHtml = adjuntoUrl
      ? `<p><a href="${adjuntoUrl}" style="color:#33482E; font-weight:bold;">📎 Ver archivo adjunto${adjuntoNombre ? `: ${adjuntoNombre}` : ""}</a></p>`
      : "";

    await enviarCorreo({
      to: q.clienteEmail,
      subject: `Nuevo mensaje sobre tu cotización — So Italian Catering`,
      html: `<div style="font-family:sans-serif;"><p>Hola ${q.clienteNombre},</p><p>${texto || ""}</p>${adjuntoHtml}<p>— So Italian Catering</p></div>`,
      apiKey: RESEND_API_KEY.value()
    });

    return { ok: true };
  }
);

// ------------------------------------------------------------------
// 3. Llamada desde el panel cuando cambia el estado de una cotización.
// ------------------------------------------------------------------
exports.sendStatusUpdateEmail = onCall(
  { secrets: [RESEND_API_KEY] },
  async (request) => {
    if (!request.auth) throw new Error("No autorizado");
    const { quoteId, nuevoEstado } = request.data;

    // Se lee DESPUÉS de que el panel ya guardó los cambios en Firestore,
    // así que esto refleja el menú/total/personas más actuales.
    const snap = await db.collection("cotizaciones").doc(quoteId).get();
    if (!snap.exists) throw new Error("Cotización no encontrada");
    const q = snap.data();

    const html = `
      <div style="font-family:sans-serif; color:#2B2119;">
        <h2 style="color:#33482E;">So Italian Catering</h2>
        <p>Hola ${q.clienteNombre}, tu cotización fue actualizada. Este es el resumen más reciente:</p>
        <p><strong>Fecha del evento:</strong> ${q.fechaEvento}<br>
           <strong>Número de personas:</strong> ${q.numPersonas}<br>
           <strong>Estado:</strong> ${nuevoEstado}</p>
        <table style="width:100%; border-collapse:collapse; margin:12px 0;">
          ${itemsHtml(q.items, q.numPersonas)}
          <tr><td style="padding:8px; font-weight:bold; border-top:2px solid #33482E;">Total actualizado</td>
              <td style="padding:8px; font-weight:bold; text-align:right; border-top:2px solid #33482E;">${fmtQ(q.total)}</td></tr>
        </table>
        <p>Cualquier duda, respondé este correo o escribinos por este medio.</p>
        <p>— So Italian Catering</p>
      </div>
    `;

    await enviarCorreo({
      to: q.clienteEmail,
      subject: `Tu cotización fue actualizada — So Italian Catering`,
      html,
      apiKey: RESEND_API_KEY.value()
    });

    return { ok: true };
  }
);
