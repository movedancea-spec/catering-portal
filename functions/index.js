const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onCall } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

const RESEND_API_KEY = defineSecret("RESEND_API_KEY");

// Shared sending domain while every tenant is in demo mode. Once a tenant
// (or the platform) verifies its own domain in Resend, this can become
// per-tenant instead of one shared address.
const FROM_EMAIL = "Catering Quotes <onboarding@resend.dev>";

// Where YOU (the platform owner) get told about platform-level things
// like a new restaurant signing up. NOT the same as a restaurant's own
// "new lead" notification — that goes to their own ownerEmail.
const PLATFORM_OWNER_EMAIL = "movedancea@gmail.com";

async function enviarCorreo({ to, subject, html, apiKey }) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM_EMAIL, to, subject, html })
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Resend error: ${res.status} ${errText}`);
  }
}

function fmtPrice(n) { return `$${Number(n || 0).toFixed(2)}`; }

function itemsHtml(items, personas) {
  return (items || []).map(i =>
    `<tr><td style="padding:4px 8px;">${i.nombre} × ${i.cantidad}</td><td style="padding:4px 8px; text-align:right;">${fmtPrice(i.precio * i.cantidad * personas)}</td></tr>`
  ).join("");
}

const DEFAULT_TEMPLATE = {
  businessName: "Our Restaurant",
  introText: "Hi {clientName}, thanks for your interest! Here's a preliminary summary of your quote:",
  policiesText: "",
  footerText: "Thank you for considering us for your event!",
  logoUrl: null,
  primaryColor: "#C4622D",
  accentColor: "#33482E"
};

async function getTenant(tenantId) {
  const snap = await db.collection("tenants").doc(tenantId).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

async function getTemplateSettings(tenantId) {
  const snap = await db.collection("tenants").doc(tenantId).collection("settings").doc("quoteEmail").get();
  return snap.exists ? { ...DEFAULT_TEMPLATE, ...snap.data() } : { ...DEFAULT_TEMPLATE };
}

function buildQuoteEmailHtml(q, settings, { heading, statusLine, disclaimer } = {}) {
  const accent = settings.accentColor || DEFAULT_TEMPLATE.accentColor;
  const logoHtml = settings.logoUrl
    ? `<img src="${settings.logoUrl}" alt="${settings.businessName}" style="max-height:70px; margin-bottom:14px; display:block;">`
    : `<h2 style="color:${accent}; margin-top:0;">${settings.businessName}</h2>`;

  const intro = (settings.introText || DEFAULT_TEMPLATE.introText).replace("{clientName}", q.clienteNombre);

  const policiesHtml = settings.policiesText
    ? `<div style="margin-top:16px; padding:14px; background:#F7F1E4; border-radius:8px;"><strong style="color:${accent};">Policies</strong><p style="white-space:pre-line; margin:6px 0 0; font-size:14px;">${settings.policiesText}</p></div>`
    : "";

  return `
    <div style="font-family:sans-serif; color:#2B2119; max-width:560px;">
      ${logoHtml}
      ${heading ? `<h3 style="color:${accent};">${heading}</h3>` : ""}
      <p>${intro}</p>
      <p><strong>Event date:</strong> ${q.fechaEvento}<br>
         <strong>Number of guests:</strong> ${q.numPersonas}${statusLine ? `<br><strong>Status:</strong> ${statusLine}` : ""}</p>
      <table style="width:100%; border-collapse:collapse; margin:12px 0;">
        ${itemsHtml(q.items, q.numPersonas)}
        <tr><td style="padding:8px; font-weight:bold; border-top:2px solid ${accent};">Total</td>
            <td style="padding:8px; font-weight:bold; text-align:right; border-top:2px solid ${accent};">${fmtPrice(q.total)}</td></tr>
      </table>
      ${disclaimer ? `<p><strong>${disclaimer}</strong></p>` : ""}
      ${policiesHtml}
      <p style="margin-top:16px;">${settings.footerText}</p>
    </div>
  `;
}

function requireTenantAccess(request, tenantId) {
  if (!request.auth) throw new Error("Unauthorized");
  const claims = request.auth.token;
  if (claims.role !== "superadmin" && claims.tenantId !== tenantId) {
    throw new Error("Unauthorized for this restaurant");
  }
}

// ------------------------------------------------------------------
// 1. Triggers when a client submits a quote form for any tenant.
// ------------------------------------------------------------------
exports.onCotizacionCreated = onDocumentCreated(
  { document: "tenants/{tenantId}/cotizaciones/{quoteId}", secrets: [RESEND_API_KEY] },
  async (event) => {
    const tenantId = event.params.tenantId;
    const q = event.data.data();
    const apiKey = RESEND_API_KEY.value();

    const tenant = await getTenant(tenantId);
    if (!tenant || tenant.active === false) return; // safety net, shouldn't normally happen

    const settings = await getTemplateSettings(tenantId);

    const resumenHtml = buildQuoteEmailHtml(q, settings, {
      disclaimer: "This is a preliminary price, not a final confirmation. A member of our team will be in touch soon to confirm all the details."
    });

    await enviarCorreo({
      to: q.clienteEmail,
      subject: `Your Catering Quote — ${q.fechaEvento}`,
      html: resumenHtml,
      apiKey
    });

    if (tenant.ownerEmail) {
      const avisoHtml = `
        <div style="font-family:sans-serif;">
          <h3>New quote request received</h3>
          <p><strong>${q.clienteNombre}</strong> — ${q.clienteEmail} — ${q.clienteTelefono}</p>
          <p>Event: ${q.fechaEvento} · ${q.numPersonas} guests · Total: ${fmtPrice(q.total)}</p>
          <p>Check it out in your dashboard.</p>
        </div>
      `;
      await enviarCorreo({
        to: tenant.ownerEmail,
        subject: `New quote: ${q.clienteNombre} (${q.fechaEvento})`,
        html: avisoHtml,
        apiKey
      });
    }
  }
);

// ------------------------------------------------------------------
// 2. Owner sends a message to a client.
// ------------------------------------------------------------------
exports.sendMessageToClient = onCall(
  { secrets: [RESEND_API_KEY] },
  async (request) => {
    const { tenantId, quoteId, texto, adjuntoUrl, adjuntoNombre, cotizacion } = request.data;
    requireTenantAccess(request, tenantId);

    const snap = await db.collection("tenants").doc(tenantId).collection("cotizaciones").doc(quoteId).get();
    if (!snap.exists) throw new Error("Quote not found");
    const q = snap.data();
    const settings = await getTemplateSettings(tenantId);

    const adjuntoHtml = adjuntoUrl
      ? `<p><a href="${adjuntoUrl}" style="color:${settings.accentColor}; font-weight:bold;">📎 View attached file${adjuntoNombre ? `: ${adjuntoNombre}` : ""}</a></p>`
      : "";

    const cotizacionHtml = (cotizacion && cotizacion.items && cotizacion.items.length)
      ? `
        <p><strong>Number of guests:</strong> ${cotizacion.numPersonas}</p>
        <table style="width:100%; border-collapse:collapse; margin:12px 0;">
          ${itemsHtml(cotizacion.items, cotizacion.numPersonas)}
          <tr><td style="padding:8px; font-weight:bold; border-top:2px solid ${settings.accentColor};">Total</td>
              <td style="padding:8px; font-weight:bold; text-align:right; border-top:2px solid ${settings.accentColor};">${fmtPrice(cotizacion.total)}</td></tr>
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
// 3. Quote edited or status changed — resend full summary to client.
// ------------------------------------------------------------------
exports.sendStatusUpdateEmail = onCall(
  { secrets: [RESEND_API_KEY] },
  async (request) => {
    const { tenantId, quoteId, nuevoEstado } = request.data;
    requireTenantAccess(request, tenantId);

    const snap = await db.collection("tenants").doc(tenantId).collection("cotizaciones").doc(quoteId).get();
    if (!snap.exists) throw new Error("Quote not found");
    const q = snap.data();
    const settings = await getTemplateSettings(tenantId);

    const html = buildQuoteEmailHtml(q, settings, { heading: "Your quote has been updated", statusLine: nuevoEstado });

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
// 4. Daily 9am reminder (Indiana time), across every active tenant.
// ------------------------------------------------------------------
exports.dailyFollowUpCheck = onSchedule(
  { schedule: "every day 09:00", timeZone: "America/Indiana/Indianapolis", secrets: [RESEND_API_KEY] },
  async () => {
    const snap = await db.collectionGroup("cotizaciones").where("estado", "in", ["Contacted", "Quote Sent"]).get();
    const twoDaysMs = 2 * 24 * 60 * 60 * 1000;

    const byTenant = {};
    snap.docs.forEach(d => {
      const data = d.data();
      if (!data.fechaContactado || data.recordatorioEnviado) return;
      const contactedAt = data.fechaContactado.toMillis ? data.fechaContactado.toMillis() : 0;
      if (Date.now() - contactedAt < twoDaysMs) return;
      const tenantId = d.ref.parent.parent.id;
      if (!byTenant[tenantId]) byTenant[tenantId] = [];
      byTenant[tenantId].push(d);
    });

    const apiKey = RESEND_API_KEY.value();

    for (const tenantId of Object.keys(byTenant)) {
      const tenant = await getTenant(tenantId);
      if (!tenant || tenant.active === false || !tenant.ownerEmail) continue;

      const docs = byTenant[tenantId];
      const rows = docs.map(d => {
        const q = d.data();
        return `<tr><td style="padding:6px 10px; border-bottom:1px solid #E4DAC4;">${q.clienteNombre}</td><td style="padding:6px 10px; border-bottom:1px solid #E4DAC4;">${q.clienteEmail}</td><td style="padding:6px 10px; border-bottom:1px solid #E4DAC4;">${q.fechaEvento || "—"}</td></tr>`;
      }).join("");

      const html = `
        <div style="font-family:sans-serif; color:#2B2119;">
          <h2 style="color:#33482E;">Follow-up reminder</h2>
          <p>These clients have been in "Contacted" or "Quote Sent" status for 2 or more days with no further update:</p>
          <table style="width:100%; border-collapse:collapse; margin:12px 0;">
            <tr style="text-align:left; border-bottom:2px solid #33482E;"><th style="padding:6px 10px;">Client</th><th style="padding:6px 10px;">Email</th><th style="padding:6px 10px;">Event date</th></tr>
            ${rows}
          </table>
        </div>
      `;

      await enviarCorreo({
        to: tenant.ownerEmail,
        subject: `Follow-up reminder: ${docs.length} client${docs.length > 1 ? "s" : ""} to contact`,
        html, apiKey
      });

      const batch = db.batch();
      docs.forEach(d => batch.update(d.ref, { recordatorioEnviado: true }));
      await batch.commit();
    }

    return null;
  }
);

// ------------------------------------------------------------------
// 5. ONE-TIME bootstrap: the very first person to call this becomes the
//    platform super admin. Fails if a super admin already exists.
// ------------------------------------------------------------------
exports.bootstrapSuperAdmin = onCall(async (request) => {
  if (!request.auth) throw new Error("Unauthorized");
  const existing = await db.collection("superadmins").limit(1).get();
  if (!existing.empty) throw new Error("A super admin already exists for this platform.");

  await admin.auth().setCustomUserClaims(request.auth.uid, { role: "superadmin" });
  await db.collection("superadmins").doc(request.auth.uid).set({
    email: request.auth.token.email || null,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
  return { ok: true };
});

// ------------------------------------------------------------------
// 6. Super admin creates a new restaurant account.
// ------------------------------------------------------------------
exports.createTenant = onCall(async (request) => {
  if (!request.auth || request.auth.token.role !== "superadmin") throw new Error("Unauthorized");
  const { name, slug, ownerEmail, ownerPassword } = request.data;
  if (!name || !slug || !ownerEmail || !ownerPassword) throw new Error("Missing required fields");

  const cleanSlug = slug.toLowerCase().trim().replace(/[^a-z0-9-]/g, "-");
  const tenantRef = db.collection("tenants").doc(cleanSlug);
  const existing = await tenantRef.get();
  if (existing.exists) throw new Error("That web address is already taken. Choose a different one.");

  const userRecord = await admin.auth().createUser({ email: ownerEmail, password: ownerPassword });
  await admin.auth().setCustomUserClaims(userRecord.uid, { tenantId: cleanSlug });

  await tenantRef.set({
    name, active: true, ownerEmail, ownerUid: userRecord.uid,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });

  await tenantRef.collection("settings").doc("quoteEmail").set({
    businessName: name,
    introText: "Hi {clientName}, thanks for your interest! Here's a preliminary summary of your quote:",
    policiesText: "",
    footerText: "Thank you for considering us for your event!",
    logoUrl: null,
    primaryColor: "#C4622D",
    accentColor: "#33482E"
  });

  return { ok: true, tenantId: cleanSlug };
});

// ------------------------------------------------------------------
// 7. ONE-TIME: moves the original "So Italian Catering" data (from
//    before multi-tenant support) into the new tenants/{tenantId}
//    structure, and links an existing Auth account as its owner.
// ------------------------------------------------------------------
exports.migrateLegacyData = onCall(async (request) => {
  if (!request.auth || request.auth.token.role !== "superadmin") throw new Error("Unauthorized");
  const { tenantId, ownerUid, ownerEmail } = request.data;
  if (!tenantId) throw new Error("Missing tenantId");

  const tenantRef = db.collection("tenants").doc(tenantId);
  const tenantSnap = await tenantRef.get();
  if (!tenantSnap.exists) {
    await tenantRef.set({
      name: "So Italian Catering",
      active: true,
      ownerEmail: ownerEmail || null,
      ownerUid: ownerUid || null,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  }

  const oldMenu = await db.collection("menu").get();
  for (const d of oldMenu.docs) {
    await tenantRef.collection("menu").doc(d.id).set(d.data());
  }

  const oldSettings = await db.collection("settings").doc("quoteEmail").get();
  if (oldSettings.exists) {
    await tenantRef.collection("settings").doc("quoteEmail").set(oldSettings.data(), { merge: true });
  }

  const oldQuotes = await db.collection("cotizaciones").get();
  for (const d of oldQuotes.docs) {
    await tenantRef.collection("cotizaciones").doc(d.id).set(d.data());
    const oldMsgs = await d.ref.collection("mensajes").get();
    for (const m of oldMsgs.docs) {
      await tenantRef.collection("cotizaciones").doc(d.id).collection("mensajes").doc(m.id).set(m.data());
    }
  }

  if (ownerUid) {
    await admin.auth().setCustomUserClaims(ownerUid, { tenantId });
  }

  return { ok: true, menuCount: oldMenu.size, quoteCount: oldQuotes.size };
});

// ------------------------------------------------------------------
// 8. Daily 9am reminder for events happening within 30 days, per tenant.
//    Skips quotes already Closed or Lost. Sends once per quote.
// ------------------------------------------------------------------
exports.eventDateReminderCheck = onSchedule(
  { schedule: "every day 09:30", timeZone: "America/Indiana/Indianapolis", secrets: [RESEND_API_KEY] },
  async () => {
    const snap = await db.collectionGroup("cotizaciones").get();
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const byTenant = {};
    snap.docs.forEach(d => {
      const data = d.data();
      if (data.estado === "Closed" || data.estado === "Lost") return;
      if (!data.fechaEvento || data.recordatorioEventoEnviado) return;

      const eventDate = new Date(data.fechaEvento + "T00:00:00");
      const daysUntil = Math.round((eventDate - today) / (24 * 60 * 60 * 1000));
      if (daysUntil < 0 || daysUntil > 30) return;

      const tenantId = d.ref.parent.parent.id;
      if (!byTenant[tenantId]) byTenant[tenantId] = [];
      byTenant[tenantId].push({ doc: d, daysUntil });
    });

    const apiKey = RESEND_API_KEY.value();

    for (const tenantId of Object.keys(byTenant)) {
      const tenant = await getTenant(tenantId);
      if (!tenant || tenant.active === false || !tenant.ownerEmail) continue;

      const entries = byTenant[tenantId];
      const rows = entries.map(({ doc, daysUntil }) => {
        const q = doc.data();
        return `<tr><td style="padding:6px 10px; border-bottom:1px solid #E4DAC4;">${q.clienteNombre}</td><td style="padding:6px 10px; border-bottom:1px solid #E4DAC4;">${q.clienteEmail}</td><td style="padding:6px 10px; border-bottom:1px solid #E4DAC4;">${q.fechaEvento}</td><td style="padding:6px 10px; border-bottom:1px solid #E4DAC4;">${daysUntil} day${daysUntil === 1 ? "" : "s"}</td></tr>`;
      }).join("");

      const html = `
        <div style="font-family:sans-serif; color:#2B2119;">
          <h2 style="color:#33482E;">Upcoming events reminder</h2>
          <p>These quotes have an event coming up within the next 30 days. Time to check in with these clients:</p>
          <table style="width:100%; border-collapse:collapse; margin:12px 0;">
            <tr style="text-align:left; border-bottom:2px solid #33482E;"><th style="padding:6px 10px;">Client</th><th style="padding:6px 10px;">Email</th><th style="padding:6px 10px;">Event date</th><th style="padding:6px 10px;">Time left</th></tr>
            ${rows}
          </table>
        </div>
      `;

      await enviarCorreo({
        to: tenant.ownerEmail,
        subject: `${entries.length} upcoming event${entries.length > 1 ? "s" : ""} within 30 days`,
        html, apiKey
      });

      const batch = db.batch();
      entries.forEach(({ doc }) => batch.update(doc.ref, { recordatorioEventoEnviado: true }));
      await batch.commit();
    }

    return null;
  }
);
