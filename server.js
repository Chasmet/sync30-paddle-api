import express from "express";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";

const app = express();

app.use(cors());
app.use(express.json());

const PADDLE_API_KEY = process.env.PADDLE_API_KEY;
const PADDLE_CLIENT_TOKEN = process.env.PADDLE_CLIENT_TOKEN;
const PADDLE_STANDARD_PRICE_ID = process.env.PADDLE_STANDARD_PRICE_ID;
const PADDLE_PREMIUM_PRICE_ID = process.env.PADDLE_PREMIUM_PRICE_ID;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const APP_BASE_URL = process.env.APP_BASE_URL || "https://chasmet.github.io/sync30/";

if (!PADDLE_API_KEY) throw new Error("PADDLE_API_KEY manquante");
if (!PADDLE_CLIENT_TOKEN) throw new Error("PADDLE_CLIENT_TOKEN manquante");
if (!PADDLE_STANDARD_PRICE_ID) throw new Error("PADDLE_STANDARD_PRICE_ID manquante");
if (!PADDLE_PREMIUM_PRICE_ID) throw new Error("PADDLE_PREMIUM_PRICE_ID manquante");
if (!SUPABASE_URL) throw new Error("SUPABASE_URL manquante");
if (!SUPABASE_SERVICE_KEY) throw new Error("SUPABASE_SERVICE_KEY manquante");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const STANDARD_SECONDS = 30;
const PREMIUM_SECONDS = 30;

function getUserId(req) {
  return String(req.headers["x-user-id"] || "").trim();
}

function getPackConfig(pack) {
  if (pack === "nova") {
    return {
      priceId: PADDLE_STANDARD_PRICE_ID,
      seconds: STANDARD_SECONDS,
      balanceField: "syncup_seconds_balance",
      label: "Standard Nova"
    };
  }

  if (pack === "astra") {
    return {
      priceId: PADDLE_PREMIUM_PRICE_ID,
      seconds: PREMIUM_SECONDS,
      balanceField: "premium_seconds_balance",
      label: "Premium Astra"
    };
  }

  return null;
}

function normalizeEmail(email) {
  const value = String(email || "").trim();
  return value || null;
}

function extractEventType(body) {
  return body?.event_type || body?.eventType || body?.event_name || "";
}

function extractPayloadData(body) {
  return body?.data || body?.event_data || {};
}

function extractTransactionId(body, payload) {
  return (
    payload?.id ||
    payload?.transaction_id ||
    body?.notification_id ||
    body?.id ||
    ""
  );
}

async function ensureWallet(userId) {
  const { data, error } = await supabase
    .from("time_wallets")
    .select("user_id, syncup_seconds_balance, premium_seconds_balance")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;

  if (data) return data;

  const { data: inserted, error: insertError } = await supabase
    .from("time_wallets")
    .insert({
      user_id: userId,
      seconds_balance: 0,
      standard_seconds_balance: 0,
      premium_seconds_balance: 0,
      syncup_seconds_balance: 0
    })
    .select("user_id, syncup_seconds_balance, premium_seconds_balance")
    .single();

  if (insertError) throw insertError;
  return inserted;
}

async function ensurePaymentsTable() {
  const { error } = await supabase.rpc("create_sync30_payments_table_if_missing");
  if (error) {
    console.log("RPC create_sync30_payments_table_if_missing indisponible, on continue sans RPC.");
  }
}

async function wasTransactionAlreadyProcessed(transactionId) {
  if (!transactionId) return false;

  const { data, error } = await supabase
    .from("sync30_payments")
    .select("transaction_id")
    .eq("transaction_id", transactionId)
    .maybeSingle();

  if (error) {
    if (
      String(error.message || "").toLowerCase().includes("relation") ||
      String(error.message || "").toLowerCase().includes("does not exist")
    ) {
      return false;
    }
    throw error;
  }

  return !!data;
}

async function saveProcessedTransaction({
  transactionId,
  userId,
  pack,
  secondsCredited,
  rawPayload
}) {
  if (!transactionId) return;

  const { error } = await supabase
    .from("sync30_payments")
    .insert({
      transaction_id: transactionId,
      user_id: userId,
      pack,
      seconds_credited: secondsCredited,
      raw_payload: rawPayload
    });

  if (error) {
    if (
      String(error.message || "").toLowerCase().includes("relation") ||
      String(error.message || "").toLowerCase().includes("does not exist")
    ) {
      return;
    }

    if (
      String(error.message || "").toLowerCase().includes("duplicate") ||
      String(error.message || "").toLowerCase().includes("unique")
    ) {
      return;
    }

    throw error;
  }
}

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    status: "Paddle payment server active"
  });
});

app.get("/paddle-config", (_req, res) => {
  res.json({
    ok: true,
    clientToken: PADDLE_CLIENT_TOKEN,
    standardPriceId: PADDLE_STANDARD_PRICE_ID,
    premiumPriceId: PADDLE_PREMIUM_PRICE_ID
  });
});

app.post("/create-checkout-link", async (req, res) => {
  try {
    const userId = getUserId(req);
    const pack = String(req.body?.pack || "").trim().toLowerCase();
    const email = normalizeEmail(req.body?.email);

    if (!userId) {
      return res.status(400).json({
        ok: false,
        error: "Utilisateur manquant"
      });
    }

    const config = getPackConfig(pack);

    if (!config) {
      return res.status(400).json({
        ok: false,
        error: "Pack invalide"
      });
    }

    const payload = {
      items: [
        {
          price_id: config.priceId,
          quantity: 1
        }
      ],
      custom_data: {
        user_id: userId,
        pack,
        credited_seconds: config.seconds
      },
      checkout: {
        success_url: `${APP_BASE_URL}?payment=success&pack=${pack}`,
        allow_logout: false
      }
    };

    if (email) {
      payload.customer = { email };
    }

    const response = await fetch("https://api.paddle.com/transactions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${PADDLE_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(500).json({
        ok: false,
        error: data?.error?.detail || data?.error?.type || "Erreur Paddle"
      });
    }

    const checkoutUrl = data?.data?.checkout?.url;

    if (!checkoutUrl) {
      return res.status(500).json({
        ok: false,
        error: "URL de paiement introuvable"
      });
    }

    return res.json({
      ok: true,
      checkoutUrl
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "Erreur serveur"
    });
  }
});

app.post("/paddle-webhook", async (req, res) => {
  try {
    await ensurePaymentsTable();

    const eventType = extractEventType(req.body);
    const payload = extractPayloadData(req.body);
    const transactionId = extractTransactionId(req.body, payload);

    if (eventType !== "transaction.completed") {
      return res.status(200).json({ ok: true, ignored: true });
    }

    const status = payload?.status || "completed";
    const customData = payload?.custom_data || {};
    const userId = String(customData?.user_id || "").trim();
    const pack = String(customData?.pack || "").trim().toLowerCase();

    if (status !== "completed" || !userId || !pack) {
      return res.status(200).json({ ok: true, ignored: true });
    }

    const config = getPackConfig(pack);
    if (!config) {
      return res.status(200).json({ ok: true, ignored: true });
    }

    const alreadyProcessed = await wasTransactionAlreadyProcessed(transactionId);

    if (alreadyProcessed) {
      return res.status(200).json({
        ok: true,
        ignored: true,
        reason: "already_processed"
      });
    }

    await ensureWallet(userId);

    const { data: wallet, error: walletError } = await supabase
      .from("time_wallets")
      .select("syncup_seconds_balance, premium_seconds_balance")
      .eq("user_id", userId)
      .single();

    if (walletError) throw walletError;

    const currentValue = Number(wallet?.[config.balanceField] || 0);
    const newValue = currentValue + config.seconds;

    const { error: updateError } = await supabase
      .from("time_wallets")
      .update({
        [config.balanceField]: newValue
      })
      .eq("user_id", userId);

    if (updateError) throw updateError;

    await saveProcessedTransaction({
      transactionId,
      userId,
      pack,
      secondsCredited: config.seconds,
      rawPayload: req.body
    });

    return res.status(200).json({
      ok: true,
      credited: config.seconds,
      pack: config.label
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "Erreur webhook"
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Paddle server running on port ${PORT}`);
});
