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
    const webhookPath = "/telegram/webhook";
    const webhookUrl = process.env.TELEGRAM_WEBHOOK_URL;
    const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET || token.slice(-24);

    if (!webhookUrl) {
      throw new Error("Missing TELEGRAM_WEBHOOK_URL for webhook mode.");
    }

    await bot.setWebHook(`${webhookUrl}${webhookPath}`, {
      secret_token: webhookSecret,
    });

    app.post(webhookPath, (req, res) => {
      if (req.get("x-telegram-bot-api-secret-token") !== webhookSecret) {
        res.sendStatus(401);
        return;
      }

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

  const buyerMainKeyboard = {
    reply_markup: {
      keyboard: [
        ["Xem menu", "Xem giỏ hàng"],
        ["Checkout", "/help"],
        ["Chế độ LIST", "Chế độ AI"],
      ],
      resize_keyboard: true,
    },
  };

  async function syncPaidAndNotify(externalOrderCode, sourceLabel) {
    const targetCode = String(externalOrderCode || "").trim();
    if (!targetCode) {
      return null;
    }

    const orders = await orderService.listOrders();
    const matched = orders.find((order) => {
      const appOrderCode = String(order.orderCode || "").toUpperCase();
      const payosOrderCode = String(order.payment && order.payment.providerOrderCode || "");
      const targetUpper = targetCode.toUpperCase();
      return appOrderCode === targetUpper || payosOrderCode === targetCode;
    });

    if (!matched) {
      return null;
    }

    if (matched.paymentStatus === orderService.PAYMENT_STATUS.PAID) {
      return matched;
    }

    const updated = await orderService.updateOrderPayment(matched.orderCode, orderService.PAYMENT_STATUS.PAID);
    if (!updated) {
      return null;
    }

    await bot.sendMessage(
      updated.chatId,
      [
        `Thanh toan PayOS thanh cong cho don ${updated.orderCode}.`,
        "Ban co the tiep tuc chon mon khac hoac xem gio hang.",
      ].join("\n"),
      buyerMainKeyboard
    );

    if (adminChatId && String(adminChatId) !== String(updated.chatId)) {
      await bot.sendMessage(
        adminChatId,
        `Don ${updated.orderCode} da thanh toan thanh cong qua PayOS (${sourceLabel}).`
      );
    }

    return updated;
  }

  app.post("/webhooks/payos", async (req, res) => {
    const signature = req.headers["x-payos-signature"];
    const result = paymentService.handlePaymentWebhook(req.body, signature);

    if (!result.success) {
      res.status(401).json({ success: false, message: result.error || "Invalid webhook" });
      return;
    }

    if (result.orderCode) {
      const paymentStatus = result.status === "PAID" ? orderService.PAYMENT_STATUS.PAID : orderService.PAYMENT_STATUS.FAILED;
      const currentOrder = await orderService.getOrderByCode(result.orderCode);
      const shouldNotify = currentOrder && currentOrder.paymentStatus !== paymentStatus;
      const updatedOrder = await orderService.updateOrderPayment(result.orderCode, paymentStatus);

      if (shouldNotify && updatedOrder) {
        if (paymentStatus === orderService.PAYMENT_STATUS.PAID) {
          await bot.sendMessage(
            updatedOrder.chatId,
            `Thanh toan PayOS thanh cong cho don ${updatedOrder.orderCode}. Cam on ban!`
          );

          if (adminChatId && String(adminChatId) !== String(updatedOrder.chatId)) {
            await bot.sendMessage(
              adminChatId,
              `Don ${updatedOrder.orderCode} da thanh toan thanh cong qua PayOS.`
            );
          }
        } else if (paymentStatus === orderService.PAYMENT_STATUS.FAILED) {
          await bot.sendMessage(
            updatedOrder.chatId,
            `Thanh toan PayOS cho don ${updatedOrder.orderCode} chua thanh cong. Ban co the thanh toan lai bang /qr ${updatedOrder.orderCode}.`
          );
        }
      }

      if (result.status === "PAID") {
        await syncPaidAndNotify(result.orderCode, "webhook");
      }
    }

    res.json({ success: true });
  });

  app.get("/payment/success", (req, res) => {
    const orderCode = String(req.query.orderCode || "").trim();
    const orderLine = orderCode ? `<p>Ma don: <strong>${orderCode}</strong></p>` : "";

    void syncPaidAndNotify(orderCode, "return-url");

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