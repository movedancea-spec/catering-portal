const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onCall } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
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
// Email template settings: logo, business name, intro/policies/footer
// text, editable anytime from the dashboard's "Email Template" tab.
// Every quote email is built from these settings, with sensible
// defaults if the owner hasn't customized anything yet.
// ------------------------------------------------------------------
const DEFAULT_TEMPLATE = {
  businessName: "So Italian Catering",
  introText: "Hi {clientName}, thanks for your interest! Here's a preliminary summary of your quote:",
  policiesText: "",
  footerText: "Thank you for considering us for your event!",
  logoUrl: null
};

async function getTemplateSettings() {
  const snap = await db.collection("settings").doc("quoteEmail").get();
  return snap.exists ? { ...DEFAULT_TEMPLATE, ...snap.data() } : { ...DEFAULT_TEMPLATE };
}

// Builds the shared quote-email HTML using the current template settings.
// `heading` / `statusLine` / `disclaimer` are optional extras used by the
// different email types (new quote vs. update vs. plain message).
function buildQuoteEmailHtml(q, settings, { heading, statusLine, disclaimer } = {}) {
  const logoHtml = settings.logoUrl
    ? `<img src="${settings.logoUrl}" alt="${settings.businessName}" style="max-height:70px; margin-bottom:14px; display:block;">`
    : `<h2 style="color:#33482E; margin-top:0;">${settings.businessName}</h2>`;

  const intro = (settings.introText || DEFAULT_TEMPLATE.introText).replace("{clientName}", q.clienteNombre);

  const policiesHtml = settings.policiesText
    ? `<div style="margin-top:16px; padding:14px; background:#F7F1E4; border-radius:8px;"><strong style="color:#33482E;">Policies</strong><p style="white-space:pre-line; margin:6px 0 0; font-size:14px;">${settings.policiesText}</p></div>`
    : "";

  return `
    <div style="font-family:sans-serif; color:#2B2119; max-width:560px;">
      ${logoHtml}
      ${heading ? `<h3 style="color:#33482E;">${heading}</h3>` : ""}
      <p>${intro}</p>
      <p><strong>Event date:</strong> ${q.fechaEvento}<br>
         <strong>Number of guests:</strong> ${q.numPersonas}${statusLine ? `<br><strong>Status:</strong> ${statusLine}` : ""}</p>
      <table style="width:100%; border-collapse:collapse; margin:12px 0;">
        ${itemsHtml(q.items, q.numPersonas)}
        <tr><td style="padding:8px; font-weight:bold; border-top:2px solid #33482E;">Total</td>
            <td style="padding:8px; font-weight:bold; text-align:right; border-top:2px solid #33482E;">${fmtPrice(q.total)}</td></tr>
      </table>
      ${disclaimer ? `<p><strong>${disclaimer}</strong></p>` : ""}
      ${policiesHtml}
      <p style="margin-top:16px;">${settings.footerText}</p>
    </div>
  `;
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
    const settings = await getTemplateSettings();

    const resumenHtml = buildQuoteEmailHtml(q, settings, {
      disclaimer: "This is a preliminary price, not a final confirmation. A member of our team will be in touch soon to confirm all the details."
    });

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
    const { quoteId, texto, adjuntoUrl, adjuntoNombre, cotizacion } = request.data;

    const snap = await db.collection("cotizaciones").doc(quoteId).get();
    if (!snap.exists) throw new Error("Quote not found");
    const q = snap.data();
    const settings = await getTemplateSettings();

    const adjuntoHtml = adjuntoUrl
      ? `<p><a href="${adjuntoUrl}" style="color:#33482E; font-weight:bold;">📎 View attached file${adjuntoNombre ? `: ${adjuntoNombre}` : ""}</a></p>`
      : "";

    const cotizacionHtml = (cotizacion && cotizacion.items && cotizacion.items.length)
      ? `
        <p><strong>Number of guests:</strong> ${cotizacion.numPersonas}</p>
        <table style="width:100%; border-collapse:collapse; margin:12px 0;">
          ${itemsHtml(cotizacion.items, cotizacion.numPersonas)}
          <tr><td style="padding:8px; font-weight:bold; border-top:2px solid #33482E;">Total</td>
              <td style="padding:8px; font-weight:bold; text-align:right; border-top:2px solid #33482E;">${fmtPrice(cotizacion.total)}</td></tr>
        </table>`
      : "";

    const logoHtml = settings.logoUrl
      ? `<img src="${settings.logoUrl}" alt="${settings.businessName}" style="max-height:60px; margin-bottom:12px; display:block;">`
      : "";

    await enviarCorreo({
      to: q.clienteEmail,
      subject: `New message about your quote — ${settings.businessName}`,
      html: `<div style="font-family:sans-serif; color:#2B2119;">${logoHtml}<p>Hi ${q.clienteNombre},</p><p>${texto || ""}</p>${cotizacionHtml}${adjuntoHtml}<p>— ${settings.businessName}</p></div>`,
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
    const settings = await getTemplateSettings();

    const html = buildQuoteEmailHtml(q, settings, {
      heading: "Your quote has been updated",
      statusLine: nuevoEstado
    });

    await enviarCorreo({
      to: q.clienteEmail,
      subject: `Your Quote Has Been Updated — ${settings.businessName}`,
      html,
      apiKey: RESEND_API_KEY.value()
    });

    return { ok: true };
  }
);

// ------------------------------------------------------------------
// 4. Runs automatically every day at 9am (Indiana / Eastern time).
//    Emails the owner a reminder for any quote that's been sitting in
//    "Contacted" or "Quote Sent" status for 2+ days with no further update.
// ------------------------------------------------------------------
exports.dailyFollowUpCheck = onSchedule(
  { schedule: "every day 09:00", timeZone: "America/Indiana/Indianapolis", secrets: [RESEND_API_KEY] },
  async () => {
    const snap = await db.collection("cotizaciones").where("estado", "in", ["Contacted", "Quote Sent"]).get();
    const twoDaysMs = 2 * 24 * 60 * 60 * 1000;

    const pending = snap.docs.filter(d => {
      const data = d.data();
      if (!data.fechaContactado || data.recordatorioEnviado) return false;
      const contactedAt = data.fechaContactado.toMillis ? data.fechaContactado.toMillis() : 0;
      return Date.now() - contactedAt >= twoDaysMs;
    });

    if (pending.length === 0) return null;

    const rows = pending.map(d => {
      const q = d.data();
      return `<tr><td style="padding:6px 10px; border-bottom:1px solid #E4DAC4;">${q.clienteNombre}</td><td style="padding:6px 10px; border-bottom:1px solid #E4DAC4;">${q.clienteEmail}</td><td style="padding:6px 10px; border-bottom:1px solid #E4DAC4;">${q.fechaEvento || "—"}</td></tr>`;
    }).join("");

    const html = `
      <div style="font-family:sans-serif; color:#2B2119;">
        <h2 style="color:#33482E;">Follow-up reminder</h2>
        <p>These clients have been in "Contacted" or "Quote Sent" status for 2 or more days with no further update. Time to reach out again:</p>
        <table style="width:100%; border-collapse:collapse; margin:12px 0;">
          <tr style="text-align:left; border-bottom:2px solid #33482E;">
            <th style="padding:6px 10px;">Client</th><th style="padding:6px 10px;">Email</th><th style="padding:6px 10px;">Event date</th>
          </tr>
          ${rows}
        </table>
        <p>Check the full details in the admin dashboard.</p>
      </div>
    `;

    await enviarCorreo({
      to: OWNER_EMAIL,
      subject: `Follow-up reminder: ${pending.length} client${pending.length > 1 ? "s" : ""} to contact`,
      html,
      apiKey: RESEND_API_KEY.value()
    });

    const batch = db.batch();
    pending.forEach(d => batch.update(d.ref, { recordatorioEnviado: true }));
    await batch.commit();

    return null;
  }
);
