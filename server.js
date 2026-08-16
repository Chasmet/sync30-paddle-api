import express from "express";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(cors());
app.use(express.json());

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL) throw new Error("SUPABASE_URL manquante");
if (!SUPABASE_SERVICE_KEY) throw new Error("SUPABASE_SERVICE_KEY manquante");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const ADMIN_EMAIL = "skypieachannel" + "@" + "gmail.com";

const PURCHASE_PACKS = {
  nova: { label: "Standard Nova", amount: 2.19 },
  astra: { label: "Premium Astra", amount: 4.19 },
  creator: { label: "Pack Créateur", amount: 7.99 }
};

function cleanEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function cleanText(value, max = 120) {
  return String(value || "").trim().slice(0, max);
}

function getBearerToken(req) {
  return String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
}

function getPackConfig(pack) {
  const value = String(pack || "").trim().toLowerCase();
  if (value === "nova") return { label: "Standard Nova", syncup: 30, premium: 0 };
  if (value === "astra") return { label: "Premium Astra", syncup: 0, premium: 30 };
  if (value === "creator_nova") return { label: "Créateur Nova", syncup: 110, premium: 0 };
  if (value === "creator_astra") return { label: "Créateur Astra", syncup: 0, premium: 60 };
  return null;
}

async function requireAdmin(req) {
  const token = getBearerToken(req);
  if (!token) return false;
  const { data, error } = await supabase.auth.getUser(token);
  if (error) return false;
  return cleanEmail(data?.user?.email) === ADMIN_EMAIL;
}

async function findUserByEmail(email) {
  const target = cleanEmail(email);
  if (!target) return null;
  let page = 1;
  const perPage = 1000;
  while (page <= 20) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    const users = data?.users || [];
    const found = users.find((user) => cleanEmail(user.email) === target);
    if (found) return found;
    if (users.length < perPage) break;
    page += 1;
  }
  return null;
}

async function ensureWallet(userId) {
  const fields = "user_id, seconds_balance, standard_seconds_balance, premium_seconds_balance, syncup_seconds_balance";
  const { data, error } = await supabase.from("time_wallets").select(fields).eq("user_id", userId).maybeSingle();
  if (error) throw error;
  if (data) return data;

  const { data: inserted, error: insertError } = await supabase
    .from("time_wallets")
    .insert({ user_id: userId, seconds_balance: 0, standard_seconds_balance: 0, premium_seconds_balance: 0, syncup_seconds_balance: 0 })
    .select(fields)
    .single();

  if (insertError) throw insertError;
  return inserted;
}

async function creditUser(userId, userEmail, pack) {
  const config = getPackConfig(pack);
  if (!config) throw new Error("Pack de crédits invalide");

  const wallet = await ensureWallet(userId);
  const nextSyncup = Number(wallet.syncup_seconds_balance || 0) + config.syncup;
  const nextPremium = Number(wallet.premium_seconds_balance || 0) + config.premium;
  const nextStandard = Number(wallet.standard_seconds_balance || 0) + config.syncup;

  const { error: updateError } = await supabase
    .from("time_wallets")
    .update({
      syncup_seconds_balance: nextSyncup,
      premium_seconds_balance: nextPremium,
      standard_seconds_balance: nextStandard,
      seconds_balance: nextStandard
    })
    .eq("user_id", userId);

  if (updateError) throw updateError;

  return {
    userId,
    userEmail: cleanEmail(userEmail),
    pack,
    label: config.label,
    addedSyncupSeconds: config.syncup,
    addedPremiumSeconds: config.premium,
    syncupSecondsBalance: nextSyncup,
    premiumSecondsBalance: nextPremium,
    standardSecondsBalance: nextStandard
  };
}

app.get("/", (_req, res) => {
  res.json({ ok: true, status: "Sync30 purchase queue + admin credits API active" });
});

app.post("/purchase-request", async (req, res) => {
  try {
    const email = cleanEmail(req.body?.userEmail);
    const pack = cleanText(req.body?.pack, 30).toLowerCase();
    const source = cleanText(req.body?.source || "sync30", 80);
    const packInfo = PURCHASE_PACKS[pack];

    if (!email) return res.status(400).json({ ok: false, error: "Email client manquant" });
    if (!packInfo) return res.status(400).json({ ok: false, error: "Pack invalide" });

    const user = await findUserByEmail(email);
    if (!user?.id) {
      return res.status(404).json({
        ok: false,
        error: "Compte Sync30 introuvable. Crée d’abord ton compte avec cette adresse e-mail."
      });
    }

    const { data: existing, error: existingError } = await supabase
      .from("purchase_requests")
      .select("id, status, created_at")
      .eq("user_id", user.id)
      .eq("pack", pack)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existingError) throw existingError;

    if (existing?.id) {
      return res.json({
        ok: true,
        requestId: existing.id,
        reused: true,
        status: existing.status,
        label: packInfo.label,
        amount: packInfo.amount
      });
    }

    const { data: inserted, error: insertError } = await supabase
      .from("purchase_requests")
      .insert({
        user_id: user.id,
        user_email: cleanEmail(user.email),
        pack,
        amount_eur: packInfo.amount,
        status: "pending",
        source
      })
      .select("id, status, created_at")
      .single();

    if (insertError) throw insertError;

    return res.json({
      ok: true,
      requestId: inserted.id,
      reused: false,
      status: inserted.status,
      label: packInfo.label,
      amount: packInfo.amount
    });
  } catch (error) {
    console.error("PURCHASE REQUEST ERROR:", error);
    return res.status(500).json({ ok: false, error: error?.message || "Erreur serveur" });
  }
});

app.get("/admin/purchase-requests", async (req, res) => {
  try {
    const isAdmin = await requireAdmin(req);
    if (!isAdmin) return res.status(403).json({ ok: false, error: "Accès admin refusé" });

    const { data, error } = await supabase
      .from("purchase_requests")
      .select("id, user_id, user_email, pack, amount_eur, status, source, created_at, processed_at, processed_by, approved_pack")
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(100);

    if (error) throw error;
    return res.json({ ok: true, requests: data || [] });
  } catch (error) {
    console.error("ADMIN PURCHASE LIST ERROR:", error);
    return res.status(500).json({ ok: false, error: error?.message || "Erreur serveur" });
  }
});

app.post("/admin/approve-purchase", async (req, res) => {
  try {
    const isAdmin = await requireAdmin(req);
    if (!isAdmin) return res.status(403).json({ ok: false, error: "Accès admin refusé" });

    const requestId = cleanText(req.body?.requestId, 80);
    if (!requestId) return res.status(400).json({ ok: false, error: "Identifiant achat manquant" });

    const { data: purchase, error: purchaseError } = await supabase
      .from("purchase_requests")
      .select("id, user_id, user_email, pack, status")
      .eq("id", requestId)
      .maybeSingle();

    if (purchaseError) throw purchaseError;
    if (!purchase?.id) return res.status(404).json({ ok: false, error: "Achat introuvable" });
    if (purchase.status !== "pending") return res.status(409).json({ ok: false, error: "Achat déjà traité" });

    let creditPack = purchase.pack;
    if (purchase.pack === "creator") {
      creditPack = cleanText(req.body?.approvedPack, 30).toLowerCase();
      if (!["creator_nova", "creator_astra"].includes(creditPack)) {
        return res.status(400).json({ ok: false, error: "Choisis Créateur Nova ou Créateur Astra" });
      }
    }

    const credited = await creditUser(purchase.user_id, purchase.user_email, creditPack);

    const { error: updateError } = await supabase
      .from("purchase_requests")
      .update({
        status: "approved",
        approved_pack: creditPack,
        processed_at: new Date().toISOString(),
        processed_by: ADMIN_EMAIL
      })
      .eq("id", requestId)
      .eq("status", "pending");

    if (updateError) throw updateError;

    return res.json({ ok: true, requestId, ...credited });
  } catch (error) {
    console.error("ADMIN APPROVE PURCHASE ERROR:", error);
    return res.status(500).json({ ok: false, error: error?.message || "Erreur serveur" });
  }
});

app.post("/admin/reject-purchase", async (req, res) => {
  try {
    const isAdmin = await requireAdmin(req);
    if (!isAdmin) return res.status(403).json({ ok: false, error: "Accès admin refusé" });

    const requestId = cleanText(req.body?.requestId, 80);
    if (!requestId) return res.status(400).json({ ok: false, error: "Identifiant achat manquant" });

    const { data, error } = await supabase
      .from("purchase_requests")
      .update({
        status: "rejected",
        processed_at: new Date().toISOString(),
        processed_by: ADMIN_EMAIL
      })
      .eq("id", requestId)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();

    if (error) throw error;
    if (!data?.id) return res.status(404).json({ ok: false, error: "Achat introuvable ou déjà traité" });
    return res.json({ ok: true, requestId });
  } catch (error) {
    console.error("ADMIN REJECT PURCHASE ERROR:", error);
    return res.status(500).json({ ok: false, error: error?.message || "Erreur serveur" });
  }
});

app.post("/admin/find-user", async (req, res) => {
  try {
    const isAdmin = await requireAdmin(req);
    if (!isAdmin) return res.status(403).json({ ok: false, error: "Accès admin refusé" });

    const email = cleanEmail(req.body?.userEmail);
    if (!email) return res.status(400).json({ ok: false, error: "Email client manquant" });

    const user = await findUserByEmail(email);
    if (!user?.id) return res.status(404).json({ ok: false, error: "Client introuvable" });

    const wallet = await ensureWallet(user.id);
    return res.json({
      ok: true,
      userId: user.id,
      userEmail: cleanEmail(user.email),
      syncupSecondsBalance: Number(wallet.syncup_seconds_balance || 0),
      premiumSecondsBalance: Number(wallet.premium_seconds_balance || 0),
      standardSecondsBalance: Number(wallet.standard_seconds_balance || 0)
    });
  } catch (error) {
    console.error("ADMIN FIND USER ERROR:", error);
    return res.status(500).json({ ok: false, error: error?.message || "Erreur serveur" });
  }
});

app.post("/admin/add-credits", async (req, res) => {
  try {
    const isAdmin = await requireAdmin(req);
    if (!isAdmin) return res.status(403).json({ ok: false, error: "Accès admin refusé" });

    const email = cleanEmail(req.body?.userEmail);
    const pack = cleanText(req.body?.pack, 30).toLowerCase();
    if (!email) return res.status(400).json({ ok: false, error: "Email client manquant" });
    if (!getPackConfig(pack)) return res.status(400).json({ ok: false, error: "Pack invalide" });

    const user = await findUserByEmail(email);
    if (!user?.id) {
      return res.status(404).json({ ok: false, error: "Compte client introuvable. Le client doit d’abord créer un compte Sync30." });
    }

    const credited = await creditUser(user.id, user.email, pack);
    return res.json({ ok: true, ...credited });
  } catch (error) {
    console.error("ADMIN ADD CREDITS ERROR:", error);
    return res.status(500).json({ ok: false, error: error?.message || "Erreur serveur" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Sync30 purchase queue API running on port ${PORT}`);
});
