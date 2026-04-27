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

function cleanEmail(value) {
  return String(value || "").trim().toLowerCase();
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

app.get("/", (_req, res) => {
  res.json({ ok: true, status: "Sync30 Revolut admin credits API active" });
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
    const pack = String(req.body?.pack || "").trim().toLowerCase();
    const config = getPackConfig(pack);

    if (!email) return res.status(400).json({ ok: false, error: "Email client manquant" });
    if (!config) return res.status(400).json({ ok: false, error: "Pack invalide" });

    const user = await findUserByEmail(email);
    if (!user?.id) {
      return res.status(404).json({ ok: false, error: "Compte client introuvable. Le client doit d’abord créer un compte Sync30." });
    }

    const wallet = await ensureWallet(user.id);
    const nextSyncup = Number(wallet.syncup_seconds_balance || 0) + config.syncup;
    const nextPremium = Number(wallet.premium_seconds_balance || 0) + config.premium;
    const nextStandard = Number(wallet.standard_seconds_balance || 0) + config.syncup;

    const { error: updateError } = await supabase
      .from("time_wallets")
      .update({ syncup_seconds_balance: nextSyncup, premium_seconds_balance: nextPremium, standard_seconds_balance: nextStandard, seconds_balance: nextStandard })
      .eq("user_id", user.id);

    if (updateError) throw updateError;

    return res.json({
      ok: true,
      userId: user.id,
      userEmail: cleanEmail(user.email),
      pack,
      label: config.label,
      addedSyncupSeconds: config.syncup,
      addedPremiumSeconds: config.premium,
      syncupSecondsBalance: nextSyncup,
      premiumSecondsBalance: nextPremium,
      standardSecondsBalance: nextStandard
    });
  } catch (error) {
    console.error("ADMIN ADD CREDITS ERROR:", error);
    return res.status(500).json({ ok: false, error: error?.message || "Erreur serveur" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Sync30 Revolut admin credits API running on port ${PORT}`);
});
