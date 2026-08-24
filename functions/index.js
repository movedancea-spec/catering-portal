const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onCall } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

// Set this "secret" once from the terminal (see README):
//   firebase functions:secrets:set RESEND_API_KEY
const RESEND_API_KEY = defineSecret("RESEND_API_KEY");

// DEMO MODE: using Resend's shared test domain.
// With this domain, Resend ONLY allows sending emails to the address
// you signed up with on Resend (your own email) — not to real clients yet.
// Once you have your own domain, change this line to something like
// "So Italian Catering <quotes@yourdomain.com>" and verify the domain
// in Resend (Domains → Add Domain) to be able to send to anyone.
const FROM_EMAIL = "So Italian Catering <onboarding@resend.dev>";

// Put the email you signed up with on Resend here — that's where you'll
// get the "new quote" notification, and also the only address you can
// send the test pre-quote to while in demo mode.
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

function fmtPrice(n) {
  return `$${Number(n || 0).toFixed(2)}`;
}

function itemsHtml(items, personas) {
  return (items || []).map(i =>
    `<tr><td style="padding:4px 8px;">${i.nombre} × ${i.cantidad}</td><td style="padding:4px 8px; text-align:right;">${fmtPrice(i.precio * i.cantidad * personas)}</td></tr>`
  ).join("");
}

// ------------------------------------------------------------------
// 1. Triggers automatically when a client submits the form.
//    Sends: (a) preliminary quote to the client, (b) alert to the owner.
// ------------------------------------------------------------------
exports.onCotizacionCreated = onDocumentCreated(
  { document: "cotizaciones/{quoteId}", secrets: [RESEND_API_KEY] },
  async (event) => {
    const q = event.data.data();
    const apiKey = RESEND_API_KEY.value();

    const resumenHtml = `
      <div style="font-family:sans-serif; color:#2B2119;">
        <h2 style="color:#33482E;">So Italian Catering</h2>
        <p>Hi ${q.clienteNombre}, thanks for your interest! Here's a preliminary summary of your quote:</p>
        <p><strong>Event date:</strong> ${q.fechaEvento}<br>
           <strong>Number of guests:</strong> ${q.numPersonas}</p>
        <table style="width:100%; border-collapse:collapse; margin:12px 0;">
          ${itemsHtml(q.items, q.numPersonas)}
          <tr><td style="padding:8px; font-weight:bold; border-top:2px solid #33482E;">Estimated total</td>
              <td style="padding:8px; font-weight:bold; text-align:right; border-top:2px solid #33482E;">${fmtPrice(q.total)}</td></tr>
        </table>
        <p><strong>This is a preliminary price, not a final confirmation.</strong> A member of our team will be in touch soon to confirm all the details.</p>
        <p>Thank you for considering us for your event!</p>
      </div>
    `;

    await enviarCorreo({
      to: q.clienteEmail,
      subject: `Your Catering Quote — ${q.fechaEvento}`,
      html: resumenHtml,
      apiKey
    });

    const avisoHtml = `
      <div style="font-family:sans-serif;">
        <h3>New quote request received</h3>
        <p><strong>${q.clienteNombre}</strong> — ${q.clienteEmail} — ${q.clienteTelefono}</p>
        <p>Event: ${q.fechaEvento} · ${q.numPersonas} guests · Total: ${fmtPrice(q.total)}</p>
        <p>Check it out in the admin dashboard.</p>
      </div>
    `;

    await enviarCorreo({
      to: OWNER_EMAIL,
      subject: `New quote: ${q.clienteNombre} (${q.fechaEvento})`,
      html: avisoHtml,
      apiKey
    });
  }
);

// ------------------------------------------------------------------
// 2. Called from the dashboard when the owner sends a message to a client.
// ------------------------------------------------------------------
exports.sendMessageToClient = onCall(
  { secrets: [RESEND_API_KEY] },
  async (request) => {
    if (!request.auth) throw new Error("Unauthorized");
    const { quoteId, texto, adjuntoUrl, adjuntoNombre } = request.data;

    const snap = await db.collection("cotizaciones").doc(quoteId).get();
    if (!snap.exists) throw new Error("Quote not found");
    const q = snap.data();

    const adjuntoHtml = adjuntoUrl
      ? `<p><a href="${adjuntoUrl}" style="color:#33482E; font-weight:bold;">📎 View attached file${adjuntoNombre ? `: ${adjuntoNombre}` : ""}</a></p>`
      : "";

    await enviarCorreo({
      to: q.clienteEmail,
      subject: `New message about your quote — So Italian Catering`,
      html: `<div style="font-family:sans-serif;"><p>Hi ${q.clienteNombre},</p><p>${texto || ""}</p>${adjuntoHtml}<p>— So Italian Catering</p></div>`,
      apiKey: RESEND_API_KEY.value()
    });

    return { ok: true };
  }
);

// ------------------------------------------------------------------
// 3. Called from the dashboard when a quote is edited or its status changes.
//    Sends the client the full, up-to-date quote summary.
// ------------------------------------------------------------------
exports.sendStatusUpdateEmail = onCall(
  { secrets: [RESEND_API_KEY] },
  async (request) => {
    if (!request.auth) throw new Error("Unauthorized");
    const { quoteId, nuevoEstado } = request.data;

    // Read AFTER the dashboard already saved the changes to Firestore,
    // so this reflects the most current menu/total/guest count.
    const snap = await db.collection("cotizaciones").doc(quoteId).get();
    if (!snap.exists) throw new Error("Quote not found");
    const q = snap.data();

    const html = `
      <div style="font-family:sans-serif; color:#2B2119;">
        <h2 style="color:#33482E;">So Italian Catering</h2>
        <p>Hi ${q.clienteNombre}, your quote has been updated. Here's the latest summary:</p>
        <p><strong>Event date:</strong> ${q.fechaEvento}<br>
           <strong>Number of guests:</strong> ${q.numPersonas}<br>
           <strong>Status:</strong> ${nuevoEstado}</p>
        <table style="width:100%; border-collapse:collapse; margin:12px 0;">
          ${itemsHtml(q.items, q.numPersonas)}
          <tr><td style="padding:8px; font-weight:bold; border-top:2px solid #33482E;">Updated total</td>
              <td style="padding:8px; font-weight:bold; text-align:right; border-top:2px solid #33482E;">${fmtPrice(q.total)}</td></tr>
        </table>
        <p>Any questions, just reply to this email or reach out through this channel.</p>
        <p>— So Italian Catering</p>
      </div>
    `;

    await enviarCorreo({
      to: q.clienteEmail,
      subject: `Your Quote Has Been Updated — So Italian Catering`,
      html,
      apiKey: RESEND_API_KEY.value()
    });

    return { ok: true };
  }
);
