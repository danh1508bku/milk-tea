require("dotenv").config({ override: true });

const path = require("path");
const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const menuService = require("./services/menu.service");
const cartService = require("./services/cart.service");
const orderService = require("./services/order.service");
const sessionService = require("./services/session.service");
const paymentService = require("./services/payment.service");
const llmService = require("./services/llm.service");
const { setupBotHandlers } = require("./bot/handlers");

const PORT = process.env.PORT || 3000;
const token = process.env.TELEGRAM_BOT_TOKEN;
const adminChatId = process.env.ADMIN_CHAT_ID || "";
const botMode = process.env.BOT_MODE || "polling";

if (!token) {
  throw new Error("Missing TELEGRAM_BOT_TOKEN in .env");
}

async function startApp() {
  const app = express();
  app.use(express.json());

  const orderStorageInfo = await orderService.initialize();
  const sessionStorageInfo = await sessionService.initialize();

  const menuPath = path.join(__dirname, "data", "Menu.csv");
  await menuService.loadMenuFromCsv(menuPath);

  const bot =
    botMode === "webhook"
      ? new TelegramBot(token)
      : new TelegramBot(token, { polling: true });

  if (botMode === "webhook") {
    const webhookPath = `/telegram/webhook/${token}`;
    const webhookUrl = process.env.TELEGRAM_WEBHOOK_URL;

    if (!webhookUrl) {
      throw new Error("Missing TELEGRAM_WEBHOOK_URL for webhook mode.");
    }

    await bot.setWebHook(`${webhookUrl}${webhookPath}`);

    app.post(webhookPath, (req, res) => {
      res.sendStatus(200);

      // Acknowledge Telegram immediately, then process update in background.
      setImmediate(async () => {
        try {
          await bot.processUpdate(req.body);
        } catch (error) {
          console.error("Failed to process Telegram update:", error);
        }
      });
    });
  }

  setupBotHandlers(bot, {
    menuService,
    cartService,
    orderService,
    sessionService,
    paymentService,
    llmService,
    adminChatId,
  });

  app.post("/webhooks/payos", async (req, res) => {
    const signature = req.headers["x-payos-signature"];
    const result = paymentService.handlePaymentWebhook(req.body, signature);

    if (!result.success) {
      res.status(401).json({ success: false, message: result.error || "Invalid webhook" });
      return;
    }

    if (result.orderCode) {
      const paymentStatus = result.status === "PAID" ? orderService.PAYMENT_STATUS.PAID : orderService.PAYMENT_STATUS.FAILED;
      await orderService.updateOrderPayment(result.orderCode, paymentStatus);
    }

    res.json({ success: true });
  });

  app.get("/payment/success", (req, res) => {
    const orderCode = String(req.query.orderCode || "").toUpperCase();
    const orderLine = orderCode ? `<p>Ma don: <strong>${orderCode}</strong></p>` : "";
    res.send(
      [
        "<h2>Thanh toan thanh cong</h2>",
        orderLine,
        "<p>Cam on ban da dat hang. Ban co the quay lai Telegram de tiep tuc theo doi don.</p>",
      ].join("")
    );
  });

  app.get("/payment/cancel", (req, res) => {
    const orderCode = String(req.query.orderCode || "").toUpperCase();
    const orderLine = orderCode ? `<p>Ma don: <strong>${orderCode}</strong></p>` : "";
    res.send(
      [
        "<h2>Thanh toan da huy</h2>",
        orderLine,
        "<p>Ban co the quay lai Telegram va chon thanh toan lai bang /qr &lt;orderCode&gt;.</p>",
      ].join("")
    );
  });

  app.get("/", (req, res) => {
    res.send("Milk Tea Bot is running");
  });

  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Menu loaded: ${menuService.getMenu().length} items`);
    console.log(`Bot mode: ${botMode}`);
    console.log(`Order storage mode: ${orderStorageInfo.mode}`);
    console.log(`Buyer session Redis enabled: ${sessionStorageInfo.enabled}`);
  });
}

startApp().catch((error) => {
  console.error("Failed to start application:", error);
  process.exit(1);
});