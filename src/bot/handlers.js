const {
  buildCartMessage,
  buildOrderSummaryMessage,
  formatCurrencyVND,
} = require("../utils/formatter");
const {
  validateAddCommand,
  normalizePhoneNumber,
  isValidVietnamPhone,
  normalizeDeliveryMethod,
} = require("../utils/validators");

function getMainKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        ["Xem menu", "Xem giỏ hàng"],
        ["Checkout", "/help"],
        ["Chế độ LIST", "Chế độ AI"],
      ],
      resize_keyboard: true,
    },
  };
}

function getAdminKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        ["Đơn hàng", "Menu quản lý"],
        ["Thêm món mới", "Tìm đơn hàng"],
        ["Hướng dẫn admin"],
      ],
      resize_keyboard: true,
    },
  };
}

function buildAdminHomeInlineKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Đơn hàng", callback_data: "ad:orders:list:0" },
          { text: "Menu", callback_data: "ad:menu:list:0" },
        ],
        [
          { text: "Thêm món", callback_data: "ad:menu:add:start" },
          { text: "Tìm đơn", callback_data: "ad:orders:find:start" },
        ],
      ],
    },
  };
}

function splitPipeArgs(raw) {
  return String(raw || "")
    .split("|")
    .map((part) => part.trim());
}

function parseMenuAddArgs(raw) {
  const parts = splitPipeArgs(raw);
  if (parts.length < 5) {
    return { ok: false, error: "Sai cu phap. Dung: /menuadd <item_id>|<ten>|<category>|<price_m>|<price_l>|<available>|<description>" };
  }

  const [itemId, name, category, priceM, priceL, available = "true", ...descriptionParts] = parts;
  return {
    ok: true,
    payload: {
      itemId,
      name,
      category,
      priceM,
      priceL,
      available,
      description: descriptionParts.join(" | "),
    },
  };
}

function parseMenuEditArgs(raw) {
  const parts = splitPipeArgs(raw);
  if (parts.length < 2) {
    return { ok: false, error: "Sai cu phap. Dung: /menuedit <item_id>|field=value|field=value" };
  }

  const itemId = parts[0];
  const updates = {};
  const fieldMap = {
    name: "name",
    category: "category",
    description: "description",
    price_m: "priceM",
    price_l: "priceL",
    available: "available",
  };

  for (const pair of parts.slice(1)) {
    const eqIndex = pair.indexOf("=");
    if (eqIndex <= 0) {
      return { ok: false, error: `Cap nhat khong hop le: ${pair}` };
    }

    const rawField = pair.slice(0, eqIndex).trim().toLowerCase();
    const rawValue = pair.slice(eqIndex + 1).trim();
    const mapped = fieldMap[rawField];
    if (!mapped) {
      return { ok: false, error: `Field khong duoc ho tro: ${rawField}` };
    }

    updates[mapped] = rawValue;
  }

  if (Object.keys(updates).length === 0) {
    return { ok: false, error: "Khong co field nao de cap nhat." };
  }

  return { ok: true, itemId, updates };
}

function getModeInlineKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Chế độ LIST", callback_data: "lf:mode:LIST" },
          { text: "Chế độ AI", callback_data: "lf:mode:AI" },
        ],
      ],
    },
  };
}

function buildPaymentMethodInlineKeyboard(orderCode) {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Thanh toán COD", callback_data: `pm:cod:${orderCode}` },
          { text: "Thanh toán QR PayOS", callback_data: `pm:qr:${orderCode}` },
        ],
      ],
    },
  };
}

function setupBotHandlers(bot, services) {
  const {
    menuService,
    cartService,
    orderService,
    sessionService,
    paymentService,
    llmService,
    adminChatId,
  } = services;

  const { STATES, MODES } = sessionService;

  function logEvent(event, data) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${event}]`, data);
  }

  function buildPaymentLinkMessage(orderCode, paymentLink) {
    const lines = [`Link thanh toan cho don ${orderCode}:`];
    const checkoutUrl = String(paymentLink && (paymentLink.paymentUrl || paymentLink.checkoutUrl) || "").trim();
    const qrCode = String(paymentLink && paymentLink.qrCode || "").trim();

    if (checkoutUrl) {
      lines.push(checkoutUrl);
    }

    if (qrCode) {
      lines.push("\nMa QR:");
      lines.push(qrCode.length > 700 ? `${qrCode.slice(0, 700)}...` : qrCode);
    }

    if (!checkoutUrl && !qrCode) {
      lines.push("PayOS khong tra ve link/QR hop le. Vui long thu lai sau it phut.");
    }

    lines.push("\nSau khi thanh toan xong, he thong se tu dong cap nhat trang thai don.");
    return lines.join("\n");
  }

  function logCommand(chatId, command, payload = "") {
    logEvent("COMMAND", { chatId, command, payload });
  }

  function getChatMode(chatId) {
    return sessionService.getMode(chatId);
  }

  function isAdminChat(chatId) {
    if (!adminChatId) {
      return true;
    }

    return String(chatId) === String(adminChatId);
  }

  function maskPhone(phone) {
    const value = String(phone || "");
    if (value.length < 6) {
      return value;
    }

    return `${value.slice(0, 3)}xxx${value.slice(-3)}`;
  }

  function canManageOrder(chatId, order) {
    return String(order.chatId) === String(chatId) || isAdminChat(chatId);
  }

  function getAdminFlow(chatId) {
    const session = sessionService.getSession(chatId);
    return session && session.data ? session.data.adminFlow || null : null;
  }

  function saveAdminFlow(chatId, partial) {
    const current = getAdminFlow(chatId) || {};
    sessionService.mergeData(chatId, {
      adminFlow: {
        ...current,
        ...partial,
      },
    });
  }

  function clearAdminFlow(chatId) {
    sessionService.mergeData(chatId, { adminFlow: null });
  }

  function getKeyboardByRole(chatId) {
    return isAdminChat(chatId) ? getAdminKeyboard() : getMainKeyboard();
  }

  async function denyBuyerFlowForAdmin(chatId) {
    if (!isAdminChat(chatId)) {
      return false;
    }

    await bot.sendMessage(
      chatId,
      "Tai khoan admin chi dung chuc nang quan tri. Dung /help de xem lenh quan tri.",
      getAdminKeyboard()
    );
    return true;
  }

  function buildAdminOrdersKeyboard(orders, page = 0) {
    const pageSize = 6;
    const safePage = Math.max(0, page);
    const start = safePage * pageSize;
    const current = orders.slice(start, start + pageSize);
    const rows = current.map((order) => ([{
      text: `${order.orderCode} | ${order.status} | ${order.totalAmount}đ`,
      callback_data: `ad:order:view:${order.orderCode}`,
    }]));

    const navRow = [];
    if (safePage > 0) {
      navRow.push({ text: "⬅ Trang trước", callback_data: `ad:orders:list:${safePage - 1}` });
    }
    if (start + pageSize < orders.length) {
      navRow.push({ text: "Trang sau ➡", callback_data: `ad:orders:list:${safePage + 1}` });
    }
    if (navRow.length > 0) {
      rows.push(navRow);
    }

    rows.push([{ text: "Tìm mã đơn", callback_data: "ad:orders:find:start" }]);
    rows.push([{ text: "Về bảng điều khiển", callback_data: "ad:home" }]);

    return {
      reply_markup: {
        inline_keyboard: rows,
      },
    };
  }

  function buildAdminOrderDetailKeyboard(order) {
    const rows = [];
    if (order.status !== orderService.ORDER_STATUS.DELIVERED) {
      rows.push([{ text: "Xác nhận đã giao", callback_data: `ad:order:delivered:${order.orderCode}` }]);
    }

    rows.push([
      { text: "⬅ Danh sách đơn", callback_data: "ad:orders:list:0" },
      { text: "Về bảng điều khiển", callback_data: "ad:home" },
    ]);

    return {
      reply_markup: {
        inline_keyboard: rows,
      },
    };
  }

  function buildAdminMenuKeyboard(items, page = 0) {
    const pageSize = 8;
    const safePage = Math.max(0, page);
    const start = safePage * pageSize;
    const current = items.slice(start, start + pageSize);
    const rows = current.map((item) => ([{
      text: `${item.itemId} | ${item.name}`,
      callback_data: `ad:menu:view:${item.itemId}`,
    }]));

    const navRow = [];
    if (safePage > 0) {
      navRow.push({ text: "⬅ Trang trước", callback_data: `ad:menu:list:${safePage - 1}` });
    }
    if (start + pageSize < items.length) {
      navRow.push({ text: "Trang sau ➡", callback_data: `ad:menu:list:${safePage + 1}` });
    }
    if (navRow.length > 0) {
      rows.push(navRow);
    }

    rows.push([{ text: "Thêm món mới", callback_data: "ad:menu:add:start" }]);
    rows.push([{ text: "Về bảng điều khiển", callback_data: "ad:home" }]);

    return {
      reply_markup: {
        inline_keyboard: rows,
      },
    };
  }

  function buildAdminMenuItemKeyboard(item) {
    return {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Sửa thông tin", callback_data: `ad:menu:edit:start:${item.itemId}` },
            { text: "Xóa món", callback_data: `ad:menu:delete:confirm:${item.itemId}` },
          ],
          [
            {
              text: item.available ? "Đang bán: ON (bấm để tắt)" : "Đang bán: OFF (bấm để bật)",
              callback_data: `ad:menu:toggle:${item.itemId}`,
            },
          ],
          [
            { text: "⬅ Danh sách menu", callback_data: "ad:menu:list:0" },
            { text: "Về bảng điều khiển", callback_data: "ad:home" },
          ],
        ],
      },
    };
  }

  function buildAdminMenuEditFieldKeyboard(itemId) {
    return {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Tên", callback_data: `ad:menu:editfield:${itemId}:name` },
            { text: "Danh mục", callback_data: `ad:menu:editfield:${itemId}:category` },
          ],
          [
            { text: "Giá M", callback_data: `ad:menu:editfield:${itemId}:priceM` },
            { text: "Giá L", callback_data: `ad:menu:editfield:${itemId}:priceL` },
          ],
          [
            { text: "Mô tả", callback_data: `ad:menu:editfield:${itemId}:description` },
            { text: "Đang bán", callback_data: `ad:menu:editfield:${itemId}:available` },
          ],
          [{ text: "⬅ Quay lại món", callback_data: `ad:menu:view:${itemId}` }],
        ],
      },
    };
  }

  function safe(handler) {
    return async (msg, match) => {
      try {
        await handler(msg, match);
      } catch (error) {
        logEvent("ERROR", {
          chatId: msg.chat.id,
          message: error.message,
          stack: error.stack,
        });
        await bot.sendMessage(
          msg.chat.id,
          "Đã có lỗi xảy ra, bạn thử lại giúp mình nhé. Dùng /help để xem cú pháp chuẩn."
        );
      }
    };
  }

  function getCartOrEmpty(chatId) {
    const cart = cartService.getCart(chatId);
    return {
      ...cart,
      items: Array.isArray(cart.items) ? cart.items : [],
    };
  }

  function getAvailableDrinkItems() {
    return menuService
      .getMenu()
      .filter((item) => item.available && item.category !== "Topping");
  }

  function getAvailableToppings() {
    return menuService
      .getMenu()
      .filter((item) => item.available && item.category === "Topping");
  }

  function shortButtonLabel(item) {
    const maxLen = 20;
    const name = String(item.name || "");
    const shortName = name.length > maxLen ? `${name.slice(0, maxLen - 1)}…` : name;
    return `${item.itemId} | ${shortName}`;
  }

  function buildListMenuKeyboard() {
    const items = getAvailableDrinkItems();
    const rows = [];

    for (let i = 0; i < items.length; i += 2) {
      const left = items[i];
      const right = items[i + 1];
      const row = [{ text: shortButtonLabel(left), callback_data: `lf:item:${left.itemId}` }];
      if (right) {
        row.push({ text: shortButtonLabel(right), callback_data: `lf:item:${right.itemId}` });
      }
      rows.push(row);
    }

    rows.push([{ text: "Xem giỏ hàng", callback_data: "lf:cart" }]);
    rows.push([{ text: "Chọn mode", callback_data: "lf:modepicker" }]);

    return {
      reply_markup: {
        inline_keyboard: rows,
      },
    };
  }

  function buildItemActionKeyboard(itemId) {
    return {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Xem mô tả", callback_data: `lf:desc:${itemId}` },
            { text: "Xem giá", callback_data: `lf:price:${itemId}` },
          ],
          [
            { text: "Chọn size M", callback_data: `lf:size:${itemId}:M` },
            { text: "Chọn size L", callback_data: `lf:size:${itemId}:L` },
          ],
          [{ text: "⬅ Danh sách sản phẩm", callback_data: "lf:list" }],
        ],
      },
    };
  }

  function buildQuantityKeyboard(itemId, size) {
    return {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "1", callback_data: `lf:qty:${itemId}:${size}:1` },
            { text: "2", callback_data: `lf:qty:${itemId}:${size}:2` },
            { text: "3", callback_data: `lf:qty:${itemId}:${size}:3` },
            { text: "Số khác", callback_data: `lf:qtycustom:${itemId}:${size}` },
          ],
          [{ text: "⬅ Chọn lại sản phẩm", callback_data: `lf:item:${itemId}` }],
        ],
      },
    };
  }

  function buildToppingKeyboard(selectedCodes = []) {
    const toppings = getAvailableToppings();
    const rows = [];

    for (let i = 0; i < toppings.length; i += 2) {
      const row = [];
      const left = toppings[i];
      const right = toppings[i + 1];
      const leftSelected = selectedCodes.includes(left.itemId) ? "✅ " : "";
      row.push({
        text: `${leftSelected}${left.name} (+${formatCurrencyVND(left.priceM)})`,
        callback_data: `lf:top:${left.itemId}`,
      });

      if (right) {
        const rightSelected = selectedCodes.includes(right.itemId) ? "✅ " : "";
        row.push({
          text: `${rightSelected}${right.name} (+${formatCurrencyVND(right.priceM)})`,
          callback_data: `lf:top:${right.itemId}`,
        });
      }

      rows.push(row);
    }

    rows.push([
      { text: "Bỏ qua topping", callback_data: "lf:topskip" },
      { text: "Xong topping", callback_data: "lf:topdone" },
    ]);
    rows.push([{ text: "⬅ Chọn lại số lượng", callback_data: "lf:qtyback" }]);

    return {
      reply_markup: {
        inline_keyboard: rows,
      },
    };
  }

  function buildPostAddKeyboard() {
    return {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Chọn món khác", callback_data: "lf:list" }],
          [
            { text: "Xem giỏ hàng", callback_data: "lf:cart" },
            { text: "Checkout", callback_data: "lf:checkout" },
          ],
        ],
      },
    };
  }

  function getListFlow(chatId) {
    const session = sessionService.getSession(chatId);
    return session.data && session.data.listFlow ? session.data.listFlow : null;
  }

  function saveListFlow(chatId, flowData) {
    const current = getListFlow(chatId) || {};
    sessionService.mergeData(chatId, {
      listFlow: {
        ...current,
        ...flowData,
      },
    });
  }

  function clearListFlow(chatId) {
    sessionService.mergeData(chatId, { listFlow: null });
  }

  async function sendModePicker(chatId, title = "Chọn mode hoạt động:") {
    await bot.sendMessage(chatId, title, getModeInlineKeyboard());
  }

  async function sendAdminHelp(chatId) {
    await bot.sendMessage(
      chatId,
      [
        "Lenh admin:",
        "/orders - Xem danh sach don",
        "/order <orderCode> - Xem chi tiet don",
        "/delivered <orderCode> - Xac nhan da giao",
        "/menuadmin - Xem menu hien tai",
        "/menuadd <item_id>|<ten>|<category>|<price_m>|<price_l>|<available>|<description>",
        "/menuedit <item_id>|field=value|field=value",
        "/menudelete <item_id>",
        "",
        "Field cho /menuedit: name, category, description, price_m, price_l, available",
        "Category hop le: Trà Sữa, Trà Trái Cây, Cà Phê, Đá Xay, Topping",
        "",
        "Meo dung nhanh: thay vi go lenh, ban co the bam cac nut trong giao dien admin.",
      ].join("\n"),
      getAdminKeyboard()
    );
  }

  async function sendAdminDashboard(chatId, title = "Bảng điều khiển admin") {
    clearAdminFlow(chatId);
    await bot.sendMessage(chatId, title, getAdminKeyboard());
    await bot.sendMessage(chatId, "Chọn thao tác bên dưới:", buildAdminHomeInlineKeyboard());
  }

  async function sendAdminOrdersList(chatId, page = 0) {
    const orders = await orderService.listOrders();
    if (!orders.length) {
      await bot.sendMessage(chatId, "Chưa có đơn hàng nào.", getAdminKeyboard());
      return;
    }

    await bot.sendMessage(
      chatId,
      "Danh sách đơn hàng (bấm vào mã đơn để xem chi tiết):",
      buildAdminOrdersKeyboard(orders, page)
    );
  }

  async function sendAdminOrderDetail(chatId, orderCode) {
    const order = await orderService.getOrderByCode(orderCode);
    if (!order) {
      await bot.sendMessage(chatId, `Không tìm thấy đơn ${orderCode}.`, getAdminKeyboard());
      return;
    }

    const detail = buildAdminOrderDetail(order);
    await bot.sendMessage(chatId, detail, buildAdminOrderDetailKeyboard(order));
  }

  async function sendAdminMenuList(chatId, page = 0) {
    const items = menuService.getMenu();
    if (!items.length) {
      await bot.sendMessage(chatId, "Menu đang trống.", getAdminKeyboard());
      return;
    }

    await bot.sendMessage(
      chatId,
      "Danh sách menu (bấm vào món để xem/sửa/xóa):",
      buildAdminMenuKeyboard(items, page)
    );
  }

  async function sendAdminMenuItemDetail(chatId, itemId) {
    const item = menuService.getItemByCode(itemId);
    if (!item) {
      await bot.sendMessage(chatId, `Không tìm thấy món ${itemId}.`, getAdminKeyboard());
      return;
    }

    const lines = [
      `${item.itemId} | ${item.name}`,
      `Danh mục: ${item.category}`,
      `Giá M: ${item.priceM}đ`,
      `Giá L: ${item.priceL}đ`,
      `Đang bán: ${item.available ? "ON" : "OFF"}`,
      `Mô tả: ${item.description || "(trống)"}`,
    ];

    await bot.sendMessage(chatId, lines.join("\n"), buildAdminMenuItemKeyboard(item));
  }

  async function handleAdminFlowInput(chatId, text) {
    const flow = getAdminFlow(chatId);
    if (!flow || !flow.action) {
      return false;
    }

    if (flow.action === "FIND_ORDER") {
      clearAdminFlow(chatId);
      await sendAdminOrderDetail(chatId, String(text || "").trim().toUpperCase());
      return true;
    }

    if (flow.action === "ADD_MENU") {
      const draft = { ...(flow.draft || {}) };
      const step = flow.step || "itemId";
      const orderedSteps = ["itemId", "name", "category", "priceM", "priceL", "available", "description"];

      draft[step] = text;
      const currentIndex = orderedSteps.indexOf(step);
      const nextStep = currentIndex >= 0 && currentIndex < orderedSteps.length - 1 ? orderedSteps[currentIndex + 1] : null;

      if (nextStep) {
        saveAdminFlow(chatId, { action: "ADD_MENU", step: nextStep, draft });
        const questions = {
          itemId: "Nhập mã món (VD: TS20)",
          name: "Nhập tên món",
          category: "Nhập danh mục (Trà Sữa, Trà Trái Cây, Cà Phê, Đá Xay, Topping)",
          priceM: "Nhập giá size M (số nguyên)",
          priceL: "Nhập giá size L (số nguyên)",
          available: "Đang bán? nhập true hoặc false",
          description: "Nhập mô tả ngắn cho món",
        };
        await bot.sendMessage(chatId, questions[nextStep], getAdminKeyboard());
        return true;
      }

      const created = menuService.addMenuItem({
        itemId: draft.itemId,
        name: draft.name,
        category: draft.category,
        priceM: draft.priceM,
        priceL: draft.priceL,
        available: draft.available,
        description: draft.description,
      });

      if (!created.ok) {
        clearAdminFlow(chatId);
        await bot.sendMessage(chatId, `Tạo món thất bại: ${created.error}`, getAdminKeyboard());
        await sendAdminDashboard(chatId, "Bạn có thể thử lại bằng nút Thêm món mới");
        return true;
      }

      try {
        await menuService.saveMenuToCsv();
      } catch (error) {
        clearAdminFlow(chatId);
        await bot.sendMessage(chatId, `Đã tạo món nhưng lưu CSV thất bại: ${error.message}`, getAdminKeyboard());
        return true;
      }

      clearAdminFlow(chatId);
      await bot.sendMessage(chatId, `Đã thêm món ${created.item.itemId} - ${created.item.name}.`, getAdminKeyboard());
      await sendAdminMenuItemDetail(chatId, created.item.itemId);
      return true;
    }

    if (flow.action === "EDIT_MENU_FIELD") {
      const itemId = flow.itemId;
      const field = flow.field;
      const updatePayload = { [field]: text };

      const updated = menuService.updateMenuItem(itemId, updatePayload);
      if (!updated.ok) {
        clearAdminFlow(chatId);
        await bot.sendMessage(chatId, `Cập nhật thất bại: ${updated.error}`, getAdminKeyboard());
        return true;
      }

      try {
        await menuService.saveMenuToCsv();
      } catch (error) {
        clearAdminFlow(chatId);
        await bot.sendMessage(chatId, `Đã cập nhật nhưng lưu CSV thất bại: ${error.message}`, getAdminKeyboard());
        return true;
      }

      clearAdminFlow(chatId);
      await bot.sendMessage(chatId, `Đã cập nhật ${updated.item.itemId}.`, getAdminKeyboard());
      await sendAdminMenuItemDetail(chatId, updated.item.itemId);
      return true;
    }

    return false;
  }

  async function sendAdminMenu(chatId) {
    const items = menuService.getMenu();
    if (!items.length) {
      await bot.sendMessage(chatId, "Menu dang trong.", getAdminKeyboard());
      return;
    }

    const lines = items.map((item) => {
      const active = item.available ? "ON" : "OFF";
      return `${item.itemId} | ${item.name} | ${item.category} | M:${item.priceM} L:${item.priceL} | ${active}`;
    });

    await bot.sendMessage(chatId, ["MENU HIEN TAI:", ...lines].join("\n"), getAdminKeyboard());
  }

  async function sendListMenu(chatId) {
    clearListFlow(chatId);
    await bot.sendMessage(
      chatId,
      "LIST MODE: Chọn sản phẩm bằng nút bên dưới. Sau đó bot sẽ dẫn bạn chọn size, số lượng và topping.",
      buildListMenuKeyboard()
    );
  }

  async function sendItemActions(chatId, itemId) {
    const item = menuService.getItemByCode(itemId);
    if (!item || item.category === "Topping") {
      await bot.sendMessage(chatId, "Sản phẩm không hợp lệ, vui lòng chọn lại từ danh sách.", buildListMenuKeyboard());
      return;
    }

    saveListFlow(chatId, {
      itemId: item.itemId,
      size: null,
      quantity: null,
      selectedToppings: [],
    });

    await bot.sendMessage(
      chatId,
      [
        `Bạn chọn: ${item.name}`,
        "Bấm Xem mô tả / Xem giá hoặc chọn size trực tiếp.",
      ].join("\n"),
      buildItemActionKeyboard(item.itemId)
    );
  }

  async function sendToppingSelection(chatId, messageId) {
    const flow = getListFlow(chatId);
    if (!flow || !flow.itemId || !flow.size || !flow.quantity) {
      await bot.sendMessage(chatId, "Thiếu thông tin chọn món. Vui lòng bắt đầu lại từ danh sách.", buildListMenuKeyboard());
      return;
    }

    const item = menuService.getItemByCode(flow.itemId);
    if (!item) {
      await bot.sendMessage(chatId, "Không tìm thấy món đã chọn. Vui lòng chọn lại.", buildListMenuKeyboard());
      return;
    }

    const chosenToppings = (flow.selectedToppings || [])
      .map((code) => menuService.getItemByCode(code))
      .filter(Boolean)
      .map((top) => top.name);

    const toppingLine = chosenToppings.length > 0 ? chosenToppings.join(", ") : "Chưa chọn";
    const text = [
      `Món: ${item.name}`,
      `Size: ${flow.size}`,
      `Số lượng: ${flow.quantity}`,
      `Topping đã chọn: ${toppingLine}`,
      "Bấm topping để bật/tắt, rồi chọn Xong topping.",
    ].join("\n");

    const keyboard = buildToppingKeyboard(flow.selectedToppings || []);

    if (messageId) {
      try {
        await bot.editMessageText(text, {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: keyboard.reply_markup,
        });
        return;
      } catch (error) {
        logEvent("EDIT_TOPPING_MESSAGE_FAILED", { chatId, reason: error.message });
      }
    }

    await bot.sendMessage(chatId, text, keyboard);
  }

  async function finalizeListSelection(chatId, skipTopping = false) {
    const flow = getListFlow(chatId);
    if (!flow || !flow.itemId || !flow.size || !flow.quantity) {
      await bot.sendMessage(chatId, "Thiếu dữ liệu món đã chọn. Vui lòng chọn lại từ danh sách.", buildListMenuKeyboard());
      return;
    }

    const menuItem = menuService.getItemByCode(flow.itemId);
    if (!menuItem) {
      await bot.sendMessage(chatId, "Món không còn trong menu. Vui lòng chọn món khác.", buildListMenuKeyboard());
      return;
    }

    const size = String(flow.size).toUpperCase() === "L" ? "L" : "M";
    const quantity = Number.parseInt(flow.quantity, 10);
    const chosenCodes = skipTopping ? [] : Array.from(new Set(flow.selectedToppings || []));
    const chosenToppings = chosenCodes
      .map((code) => menuService.getItemByCode(code))
      .filter((item) => item && item.category === "Topping");

    const baseUnitPrice = size === "L" ? menuItem.priceL : menuItem.priceM;
    const toppingUnitPrice = chosenToppings.reduce((sum, top) => sum + Number(top.priceM || 0), 0);
    const unitPrice = baseUnitPrice + toppingUnitPrice;

    cartService.addItem(chatId, {
      itemId: menuItem.itemId,
      name: menuItem.name,
      category: menuItem.category,
      size,
      quantity,
      unitPrice,
      baseUnitPrice,
      toppingDetails: chosenToppings.map((top) => ({
        itemId: top.itemId,
        name: top.name,
        unitPrice: Number(top.priceM || 0),
      })),
      toppings: chosenToppings.map((top) => top.name),
      note: "",
    });

    clearListFlow(chatId);

    const toppingText = chosenToppings.length > 0 ? chosenToppings.map((top) => top.name).join(", ") : "Không";
    await bot.sendMessage(
      chatId,
      [
        `Đã thêm ${quantity} ${menuItem.name} size ${size} vào giỏ.`,
        `Topping: ${toppingText}`,
        `Đơn giá tính tiền: ${formatCurrencyVND(unitPrice)}`,
      ].join("\n"),
      buildPostAddKeyboard()
    );
  }

  async function sendMenu(chatId) {
    if (getChatMode(chatId) === MODES.LIST) {
      await sendListMenu(chatId);
      return;
    }

    const grouped = menuService.getMenuByCategories();
    const categoryOrder = [
      "Trà Sữa",
      "Trà Trái Cây",
      "Cà Phê",
      "Đá Xay",
      "Topping",
    ];

    const chunks = ["MENU QUAN TRA SUA"]; 

    for (const category of categoryOrder) {
      const items = grouped[category] || [];
      if (items.length === 0) {
        continue;
      }

      chunks.push(`\n${category}:`);
      for (const item of items) {
        if (category === "Topping") {
          chunks.push(`${item.index}. ${item.name} - ${formatCurrencyVND(item.priceM)}`);
        } else {
          chunks.push(
            `${item.index}. ${item.name} | M: ${formatCurrencyVND(item.priceM)} | L: ${formatCurrencyVND(item.priceL)}`
          );
        }
      }
    }

    chunks.push("\nHuong dan nhanh:");
    chunks.push("/add <item_code> <size> <quantity>");
    chunks.push('/add "<item_name>" <size> <quantity>');
    chunks.push("/cart");
    chunks.push("/checkout");

    await bot.sendMessage(chatId, chunks.join("\n"), getMainKeyboard());
  }

  function formatAdminOrderLine(order) {
    return `${order.orderCode} - ${order.customerName} - ${order.totalAmount}đ - ${order.status} - ${order.createdAt}`;
  }

  function buildAdminOrderDetail(order) {
    const itemLines = order.items.map((item) => `- ${item.quantity}x ${item.name} ${item.size}`).join("\n");
    const address = order.deliveryMethod === "delivery" ? order.address : "Nhan tai quan";

    return [
      `🧾 ĐƠN MỚI: ${order.orderCode}`,
      `Khách: ${order.customerName}`,
      `SĐT: ${order.phone || "(không có)"}`,
      `Địa chỉ: ${address}`,
      "Món:",
      itemLines,
      `Tổng: ${order.totalAmount}đ`,
      `Trạng thái: ${order.status} | Thanh toán: ${order.paymentStatus}`,
    ].join("\n");
  }

  async function notifyAdminNewOrder(order) {
    if (!adminChatId) {
      return;
    }

    try {
      await bot.sendMessage(adminChatId, buildAdminOrderDetail(order));
    } catch (error) {
      logEvent("ADMIN_NOTIFY_FAILED", { orderCode: order.orderCode, reason: error.message });
    }
  }

  function resolveMenuItemFromAddTarget(target, targetType) {
    if (targetType === "index") {
      const item = menuService.getItemByIndex(Number.parseInt(target, 10));
      if (!item) {
        return { item: null, error: "Mon khong ton tai. Dung /menu de xem danh sach." };
      }

      return { item };
    }

    const byCode = menuService.getItemByCode(target);
    if (byCode) {
      return { item: byCode };
    }

    const matches = menuService.searchItemsByName(target, {
      limit: 5,
      minScore: 0.35,
    });

    if (matches.length === 0) {
      return { item: null, error: "Khong tim thay mon phu hop. Dung /menu de xem lai." };
    }

    const [first, second] = matches;
    const isConfident = first.score >= 0.75 && (!second || first.score - second.score >= 0.15);

    if (isConfident) {
      return { item: first.item };
    }

    return { item: null, matches };
  }

  async function tryAddFromAi(chatId, text) {
    if (!llmService) {
      return false;
    }

    const parsed = await llmService.parseOrderMessage(text, menuService.getMenu());
    if (!parsed || parsed.intent !== "add_to_cart" || !Array.isArray(parsed.items) || parsed.items.length === 0) {
      return false;
    }

    const itemDraft = parsed.items[0];
    const rawTarget = itemDraft.itemId || itemDraft.itemName;
    const size = String(itemDraft.size || "").toUpperCase();
    const quantity = Number.parseInt(itemDraft.quantity, 10);

    if (!rawTarget) {
      await bot.sendMessage(chatId, "Mình chưa xác định được món bạn muốn đặt. Bạn thử nói rõ hơn hoặc dùng /menu.");
      return true;
    }

    const targetType = menuService.getItemByCode(rawTarget) ? "code_or_name" : "code_or_name";
    const resolved = resolveMenuItemFromAddTarget(rawTarget, targetType);

    if (resolved.error || resolved.matches) {
      await bot.sendMessage(chatId, "Mình chưa chắc món bạn chọn. Bạn dùng /add theo item code để chính xác hơn nhé.");
      return true;
    }

    const addCommand = `${resolved.item.itemId} ${size || "M"} ${Number.isInteger(quantity) && quantity > 0 ? quantity : 1}`;
    const validation = validateAddCommand(addCommand, resolved.item);
    if (!validation.isValid) {
      await bot.sendMessage(chatId, `Mình đã hiểu ý nhưng thiếu thông tin: ${parsed.missingFields.join(", ")}.`);
      return true;
    }

    cartService.addItem(chatId, {
      itemId: resolved.item.itemId,
      name: resolved.item.name,
      category: resolved.item.category,
      size: validation.size,
      quantity: validation.quantity,
      unitPrice: validation.unitPrice,
      baseUnitPrice: validation.unitPrice,
      toppingDetails: [],
      toppings: [],
      note: "",
    });

    await bot.sendMessage(
      chatId,
      `AI da them ${validation.quantity} ${resolved.item.name} size ${validation.size} vao gio.`,
      getMainKeyboard()
    );
    return true;
  }

  async function sendCart(chatId) {
    const cart = getCartOrEmpty(chatId);
    const message = buildCartMessage(cart);
    await bot.sendMessage(chatId, message, getMainKeyboard());
  }

  async function startCheckout(chatId) {
    if (cartService.isCartEmpty(chatId)) {
      await bot.sendMessage(chatId, "Giỏ hàng đang trống. Dùng /menu rồi /add trước khi checkout.");
      return;
    }

    sessionService.resetSession(chatId);
    sessionService.setState(chatId, STATES.WAITING_NAME);

    await bot.sendMessage(chatId, "Nhap ten nguoi nhan: ");
  }

  async function handleCheckoutStateMessage(chatId, text) {
    const session = sessionService.getSession(chatId);

    switch (session.state) {
      case STATES.WAITING_NAME: {
        if (text.length < 2) {
          await bot.sendMessage(chatId, "Ten qua ngan. Vui long nhap lai ten nguoi nhan.");
          return;
        }

        sessionService.mergeData(chatId, { customerName: text });
        sessionService.setState(chatId, STATES.WAITING_PHONE);
        await bot.sendMessage(chatId, "Nhap so dien thoai (VD: 0901234567):");
        return;
      }

      case STATES.WAITING_PHONE: {
        const normalized = normalizePhoneNumber(text);
        if (!isValidVietnamPhone(normalized)) {
          await bot.sendMessage(chatId, "So dien thoai khong hop le. Vui long nhap lai (VD: 0901234567).");
          return;
        }

        sessionService.mergeData(chatId, { phone: normalized });
        sessionService.setState(chatId, STATES.WAITING_DELIVERY_METHOD);
        await bot.sendMessage(chatId, "Chon hinh thuc nhan hang: pickup hoac delivery");
        return;
      }

      case STATES.WAITING_DELIVERY_METHOD: {
        const deliveryMethod = normalizeDeliveryMethod(text);
        if (!deliveryMethod) {
          await bot.sendMessage(chatId, "Chi chap nhan pickup hoac delivery. Vui long nhap lai.");
          return;
        }

        sessionService.mergeData(chatId, { deliveryMethod });

        if (deliveryMethod === "delivery") {
          sessionService.setState(chatId, STATES.WAITING_ADDRESS);
          await bot.sendMessage(chatId, "Nhap dia chi giao hang:");
          return;
        }

        sessionService.mergeData(chatId, { address: "" });
        sessionService.setState(chatId, STATES.WAITING_NOTE);
        await bot.sendMessage(chatId, "Nhap ghi chu them (hoac nhap - de bo qua):");
        return;
      }

      case STATES.WAITING_ADDRESS: {
        if (!text.trim()) {
          await bot.sendMessage(chatId, "Dia chi la bat buoc khi chon delivery. Vui long nhap dia chi.");
          return;
        }

        sessionService.mergeData(chatId, { address: text.trim() });
        sessionService.setState(chatId, STATES.WAITING_NOTE);
        await bot.sendMessage(chatId, "Nhap ghi chu them (hoac nhap - de bo qua):");
        return;
      }

      case STATES.WAITING_NOTE: {
        const note = text.trim() === "-" ? "" : text.trim();
        sessionService.mergeData(chatId, { note });
        sessionService.setState(chatId, STATES.CONFIRMING_ORDER);

        const data = sessionService.getSession(chatId).data;
        const cart = getCartOrEmpty(chatId);

        if (cart.items.length === 0) {
          sessionService.resetSession(chatId);
          await bot.sendMessage(chatId, "Giỏ hàng đang trống nên khong the checkout. Vui long them mon roi thu lai.");
          return;
        }

        const summary = buildOrderSummaryMessage({
          customerName: data.customerName,
          phone: data.phone,
          deliveryMethod: data.deliveryMethod,
          address: data.address || "",
          note: data.note || "",
          items: cart.items,
          totalAmount: cartService.getCartTotal(chatId),
        });

        await bot.sendMessage(chatId, summary);
        return;
      }

      case STATES.CONFIRMING_ORDER: {
        await bot.sendMessage(chatId, "Vui long nhap /confirm de chot don hoac /cancel de huy.");
        return;
      }

      case STATES.WAITING_PAYMENT: {
        await bot.sendMessage(chatId, "Don dang duoc tao, vui long doi trong giay lat.");
        return;
      }

      case STATES.IDLE:
      default:
        return;
    }
  }

  bot.onText(/^\/start$/i, safe(async (msg) => {
    logCommand(msg.chat.id, "/start");
    const isAdmin = isAdminChat(msg.chat.id);
    const mode = getChatMode(msg.chat.id);

    if (isAdmin) {
      await sendAdminDashboard(
        msg.chat.id,
        [
          "Chao admin.",
          "Ban dang o giao dien quan ly don/menu.",
          "Ban co the bam nut, khong can nho cau lenh.",
        ].join("\n")
      );
      return;
    }

    await bot.sendMessage(
      msg.chat.id,
      [
        "Chao ban, minh la bot dat tra sua.",
        `Che do hien tai: ${mode}`,
        "- LIST: chi dat theo menu co san",
        "- AI: nhap ngon ngu tu nhien de bot parse",
        "Bam nut Chon mode ben duoi hoac dung /mode list, /mode ai.",
      ].join("\n"),
      getKeyboardByRole(msg.chat.id)
    );

    await sendModePicker(msg.chat.id);
  }));

  bot.onText(/^\/help$/i, safe(async (msg) => {
    logCommand(msg.chat.id, "/help");
    if (isAdminChat(msg.chat.id)) {
      await sendAdminHelp(msg.chat.id);
      return;
    }

    const mode = getChatMode(msg.chat.id);
    await bot.sendMessage(
      msg.chat.id,
      [
        "Danh sach command:",
        "/start - Khoi dong bot",
        "/menu - Xem menu theo danh muc",
        "/add <item_code> <size> <quantity> - Them mon vao gio",
        '/add "<item_name>" <size> <quantity> - Them mon theo ten',
        "/cart - Xem gio hang",
        "/remove <line_number> - Xoa 1 dong trong gio",
        "/clearcart - Xoa toan bo gio hang",
        "/checkout - Bat dau quy trinh dat hang",
        "/confirm - Xac nhan dat don (khi dang checkout)",
        "/cod <orderCode> - Chon thanh toan COD",
        "/qr <orderCode> - Nhan link thanh toan QR PayOS",
        "/cancel - Huy checkout hien tai",
        "/ai <noi_dung> - Thu parser AI dat mon",
        "/mode - Xem che do hien tai",
        "/mode list - Ve che do dat theo danh sach",
        "/mode ai - Bat che do dat bang ngon ngu tu nhien",
        "",
        `Che do hien tai: ${mode}`,
        "Vi du: /add TS03 L 2",
        'Vi du: /add "Tra Sua Truyen Thong" L 2',
      ].join("\n"),
      getKeyboardByRole(msg.chat.id)
    );
  }));

  bot.onText(/^\/mode(?:\s+(list|ai))?$/i, safe(async (msg, match) => {
    const chatId = msg.chat.id;
    const inputMode = match && match[1] ? String(match[1]).toUpperCase() : "";
    logCommand(chatId, "/mode", inputMode);

    if (await denyBuyerFlowForAdmin(chatId)) {
      return;
    }

    if (!inputMode) {
      const currentMode = getChatMode(chatId);
      await sendModePicker(
        chatId,
        [
          `Che do hien tai: ${currentMode}`,
          "Dung /mode list de dat theo menu co san.",
          "Dung /mode ai de dat bang ngon ngu tu nhien.",
        ].join("\n")
      );
      return;
    }

    const nextMode = inputMode === "AI" ? MODES.AI : MODES.LIST;
    const result = sessionService.setMode(chatId, nextMode);
    if (!result.ok) {
      await bot.sendMessage(chatId, result.error);
      return;
    }

    if (result.mode === MODES.AI) {
      await bot.sendMessage(
        chatId,
        [
          "Da chuyen sang che do AI.",
          "Ban co the nhap tu nhien, vi du: cho minh 2 tra sua truyen thong size L",
        ].join("\n")
      );
      return;
    }

    await bot.sendMessage(
      chatId,
      [
        "Da chuyen sang che do LIST.",
        "Ban dat hang bang nut bam, khong can go /add.",
      ].join("\n")
    );

    await sendListMenu(chatId);
  }));

  bot.onText(/^\/menu$/i, safe(async (msg) => {
    const chatId = msg.chat.id;
    logCommand(chatId, "/menu");

    if (await denyBuyerFlowForAdmin(chatId)) {
      return;
    }

    await sendMenu(chatId);
  }));

  bot.onText(/^\/add(?:\s+(.+))?$/i, safe(async (msg, match) => {
    const chatId = msg.chat.id;
    const addArgs = match && match[1] ? match[1] : "";
    logCommand(chatId, "/add", addArgs);

    if (await denyBuyerFlowForAdmin(chatId)) {
      return;
    }

    if (!addArgs) {
      await bot.sendMessage(
        chatId,
        'Sai cu phap. Dung: /add <item_code> <size> <quantity> hoac /add "<item_name>" <size> <quantity>.\nVi du: /add TS03 L 2'
      );
      return;
    }

    const preValidation = validateAddCommand(addArgs);
    if (!preValidation.isValid) {
      await bot.sendMessage(chatId, preValidation.error);
      return;
    }

    const resolved = resolveMenuItemFromAddTarget(preValidation.target, preValidation.targetType);
    if (resolved.error) {
      await bot.sendMessage(chatId, resolved.error);
      return;
    }

    if (resolved.matches) {
      const options = resolved.matches
        .map((matchItem) => {
          return `${matchItem.item.itemId} - ${matchItem.item.name}`;
        })
        .join("\n");

      await bot.sendMessage(
        chatId,
        [
          "Tim thay nhieu mon gan dung, vui long chon lai bang item code:",
          options,
          `Vi du: /add ${resolved.matches[0].item.itemId} ${preValidation.size} ${preValidation.quantity}`,
        ].join("\n")
      );
      return;
    }

    const menuItem = resolved.item;
    const validation = validateAddCommand(addArgs, menuItem);

    if (!validation.isValid) {
      await bot.sendMessage(chatId, validation.error);
      return;
    }

    const cartItem = {
      itemId: menuItem.itemId,
      name: menuItem.name,
      category: menuItem.category,
      size: validation.size,
      quantity: validation.quantity,
      unitPrice: validation.unitPrice,
      baseUnitPrice: validation.unitPrice,
      toppingDetails: [],
      toppings: [],
      note: "",
    };

    cartService.addItem(chatId, cartItem);

    await bot.sendMessage(
      chatId,
      `Da them ${validation.quantity} ${menuItem.name} size ${validation.size} vao gio.`,
      getMainKeyboard()
    );
  }));

  bot.onText(/^\/cart$/i, safe(async (msg) => {
    const chatId = msg.chat.id;
    logCommand(chatId, "/cart");

    if (await denyBuyerFlowForAdmin(chatId)) {
      return;
    }

    await sendCart(chatId);
  }));

  bot.onText(/^\/remove(?:\s+(\d+))?$/i, safe(async (msg, match) => {
    const chatId = msg.chat.id;
    const lineText = match && match[1] ? match[1] : "";
    logCommand(chatId, "/remove", lineText);

    if (await denyBuyerFlowForAdmin(chatId)) {
      return;
    }

    if (!lineText) {
      await bot.sendMessage(chatId, "Sai cu phap. Dung: /remove <line_number>. Vi du: /remove 2");
      return;
    }

    const lineNumber = Number.parseInt(lineText, 10);
    const result = cartService.removeItemByLine(chatId, lineNumber);

    if (!result.ok) {
      await bot.sendMessage(chatId, result.error);
      return;
    }

    await bot.sendMessage(chatId, `Da xoa dong ${lineNumber}: ${result.removed.name}.`);
    await sendCart(chatId);
  }));

  bot.onText(/^\/clearcart$/i, safe(async (msg) => {
    const chatId = msg.chat.id;
    logCommand(chatId, "/clearcart");

    if (await denyBuyerFlowForAdmin(chatId)) {
      return;
    }

    cartService.clearCart(chatId);
    await bot.sendMessage(chatId, "Da xoa toan bo gio hang.", getMainKeyboard());
  }));

  bot.onText(/^\/checkout$/i, safe(async (msg) => {
    const chatId = msg.chat.id;
    logCommand(chatId, "/checkout");

    if (await denyBuyerFlowForAdmin(chatId)) {
      return;
    }

    await startCheckout(chatId);
  }));

  bot.onText(/^\/cancel$/i, safe(async (msg) => {
    const chatId = msg.chat.id;
    logCommand(chatId, "/cancel");

    if (await denyBuyerFlowForAdmin(chatId)) {
      return;
    }

    const state = sessionService.getSession(chatId).state;

    if (state === STATES.IDLE) {
      await bot.sendMessage(chatId, "Khong co checkout nao dang dien ra.");
      return;
    }

    sessionService.resetSession(chatId);
    await bot.sendMessage(chatId, "Da huy quy trinh checkout hien tai.", getMainKeyboard());
  }));

  bot.onText(/^\/confirm$/i, safe(async (msg) => {
    const chatId = msg.chat.id;
    logCommand(chatId, "/confirm");

    if (await denyBuyerFlowForAdmin(chatId)) {
      return;
    }

    const session = sessionService.getSession(chatId);

    if (session.state !== STATES.CONFIRMING_ORDER) {
      await bot.sendMessage(chatId, "Ban chua o buoc xac nhan. Dung /checkout de bat dau.");
      return;
    }

    const cart = getCartOrEmpty(chatId);
    if (cart.items.length === 0) {
      sessionService.resetSession(chatId);
      await bot.sendMessage(chatId, "Giỏ hàng đang trống nên không thể tạo đơn.");
      return;
    }

    const data = session.data;
    sessionService.setState(chatId, STATES.WAITING_PAYMENT);

    const order = await orderService.createOrder({
      chatId,
      customerName: data.customerName,
      phone: data.phone,
      deliveryMethod: data.deliveryMethod,
      address: data.address || "",
      note: data.note || "",
      items: cart.items,
      totalAmount: cartService.getCartTotal(chatId),
      payment: null,
      paymentMethod: null,
    });

    logEvent("ORDER_CREATED", {
      orderCode: order.orderCode,
      chatId,
      totalAmount: order.totalAmount,
      itemCount: order.items.length,
    });

    cartService.clearCart(chatId);
    sessionService.resetSession(chatId);

    await notifyAdminNewOrder(order);

    const paymentOptions = paymentService.getPaymentOptions(order.orderCode);

    await bot.sendMessage(
      chatId,
      [
        "Dat hang thanh cong!",
        `Ma don: ${order.orderCode}`,
        `Tong tien: ${formatCurrencyVND(order.totalAmount)}`,
        `Trang thai don: ${order.status}`,
        `Trang thai thanh toan: ${order.paymentStatus}`,
        "",
        "Chon phuong thuc thanh toan (bấm nút):",
        ...paymentOptions.map((opt) => opt.label),
      ].join("\n"),
      buildPaymentMethodInlineKeyboard(order.orderCode)
    );
  }));

  bot.onText(/^\/orders$/i, safe(async (msg) => {
    const chatId = msg.chat.id;
    logCommand(chatId, "/orders");

    if (!isAdminChat(chatId)) {
      await bot.sendMessage(chatId, "Ban khong co quyen dung lenh nay.", getKeyboardByRole(chatId));
      return;
    }

    await sendAdminOrdersList(chatId, 0);
  }));

  bot.onText(/^\/order(?:\s+([A-Za-z0-9]+))?$/i, safe(async (msg, match) => {
    const chatId = msg.chat.id;
    const orderCode = match && match[1] ? String(match[1]).toUpperCase() : "";
    logCommand(chatId, "/order", orderCode);

    if (!isAdminChat(chatId)) {
      await bot.sendMessage(chatId, "Ban khong co quyen dung lenh nay.", getKeyboardByRole(chatId));
      return;
    }

    if (!orderCode) {
      await bot.sendMessage(chatId, "Sai cu phap. Dung: /order <orderCode>");
      return;
    }

    const order = await orderService.getOrderByCode(orderCode);
    if (!order) {
      await bot.sendMessage(chatId, `Khong tim thay don ${orderCode}.`);
      return;
    }

    const detail = buildAdminOrderDetail(order);
    await bot.sendMessage(chatId, detail, buildAdminOrderDetailKeyboard(order));
  }));

  bot.onText(/^\/cod(?:\s+([A-Za-z0-9]+))?$/i, safe(async (msg, match) => {
    const chatId = msg.chat.id;
    const orderCode = match && match[1] ? String(match[1]).toUpperCase() : "";
    logCommand(chatId, "/cod", orderCode);

    if (await denyBuyerFlowForAdmin(chatId)) {
      return;
    }

    if (!orderCode) {
      await bot.sendMessage(chatId, "Sai cu phap. Dung: /cod <orderCode>");
      return;
    }

    const order = await orderService.getOrderByCode(orderCode);
    if (!order) {
      await bot.sendMessage(chatId, `Khong tim thay don ${orderCode}.`);
      return;
    }

    if (!canManageOrder(chatId, order)) {
      await bot.sendMessage(chatId, "Ban khong co quyen thao tac don nay.");
      return;
    }

    const choice = paymentService.choosePaymentMethod(orderCode, paymentService.PAYMENT_METHODS.COD);
    if (!choice.ok) {
      await bot.sendMessage(chatId, choice.error);
      return;
    }

    await orderService.setPaymentMethod(orderCode, choice.paymentMethod);
    await bot.sendMessage(chatId, `Da chon COD cho don ${orderCode}.`);
  }));

  bot.onText(/^\/qr(?:\s+([A-Za-z0-9]+))?$/i, safe(async (msg, match) => {
    const chatId = msg.chat.id;
    const orderCode = match && match[1] ? String(match[1]).toUpperCase() : "";
    logCommand(chatId, "/qr", orderCode);

    if (await denyBuyerFlowForAdmin(chatId)) {
      return;
    }

    if (!orderCode) {
      await bot.sendMessage(chatId, "Sai cu phap. Dung: /qr <orderCode>");
      return;
    }

    const order = await orderService.getOrderByCode(orderCode);
    if (!order) {
      await bot.sendMessage(chatId, `Khong tim thay don ${orderCode}.`);
      return;
    }

    if (!canManageOrder(chatId, order)) {
      await bot.sendMessage(chatId, "Ban khong co quyen thao tac don nay.");
      return;
    }

    const choice = paymentService.choosePaymentMethod(orderCode, paymentService.PAYMENT_METHODS.QR);
    if (!choice.ok) {
      await bot.sendMessage(chatId, choice.error);
      return;
    }

    await orderService.setPaymentMethod(orderCode, choice.paymentMethod);
    let paymentLink;
    try {
      paymentLink = await paymentService.createPaymentLink(order);
      await orderService.saveOrderPayment(orderCode, paymentLink);
    } catch (error) {
      await bot.sendMessage(chatId, `Khong tao duoc link thanh toan PayOS: ${error.message}`);
      return;
    }

    await bot.sendMessage(
      chatId,
      buildPaymentLinkMessage(orderCode, paymentLink)
    );
  }));

  bot.onText(/^\/pay(?:\s+([A-Za-z0-9]+))?$/i, safe(async (msg, match) => {
    const chatId = msg.chat.id;
    const orderCode = match && match[1] ? String(match[1]).toUpperCase() : "";
    logCommand(chatId, "/pay", orderCode);

    await bot.sendMessage(
      chatId,
      "Lenh /pay da tat trong production. Vui long thanh toan qua QR PayOS de he thong tu cap nhat."
    );
  }));

  bot.onText(/^\/delivered(?:\s+([A-Za-z0-9]+))?$/i, safe(async (msg, match) => {
    const chatId = msg.chat.id;
    const orderCode = match && match[1] ? String(match[1]).toUpperCase() : "";
    logCommand(chatId, "/delivered", orderCode);

    if (!isAdminChat(chatId)) {
      await bot.sendMessage(chatId, "Ban khong co quyen dung lenh nay.", getKeyboardByRole(chatId));
      return;
    }

    if (!orderCode) {
      await bot.sendMessage(chatId, "Sai cu phap. Dung: /delivered <orderCode>");
      return;
    }

    const updated = await orderService.markOrderDelivered(orderCode);
    if (!updated) {
      await bot.sendMessage(chatId, `Khong tim thay don ${orderCode}.`);
      return;
    }

    await bot.sendMessage(chatId, `Da xac nhan don ${orderCode} da giao.`);
    if (String(updated.chatId) !== String(chatId)) {
      await bot.sendMessage(updated.chatId, `Don ${orderCode} cua ban da duoc giao thanh cong.`);
    }
  }));

  bot.onText(/^\/menuadmin$/i, safe(async (msg) => {
    const chatId = msg.chat.id;
    logCommand(chatId, "/menuadmin");

    if (!isAdminChat(chatId)) {
      await bot.sendMessage(chatId, "Ban khong co quyen dung lenh nay.", getKeyboardByRole(chatId));
      return;
    }

    await sendAdminMenu(chatId);
  }));

  bot.onText(/^\/menuadd(?:\s+(.+))?$/i, safe(async (msg, match) => {
    const chatId = msg.chat.id;
    const rawArgs = match && match[1] ? match[1] : "";
    logCommand(chatId, "/menuadd", rawArgs);

    if (!isAdminChat(chatId)) {
      await bot.sendMessage(chatId, "Ban khong co quyen dung lenh nay.", getKeyboardByRole(chatId));
      return;
    }

    const parsed = parseMenuAddArgs(rawArgs);
    if (!parsed.ok) {
      await bot.sendMessage(chatId, parsed.error, getAdminKeyboard());
      return;
    }

    const created = menuService.addMenuItem(parsed.payload);
    if (!created.ok) {
      await bot.sendMessage(chatId, created.error, getAdminKeyboard());
      return;
    }

    try {
      await menuService.saveMenuToCsv();
    } catch (error) {
      await bot.sendMessage(chatId, `Da them mon nhung luu CSV that bai: ${error.message}`, getAdminKeyboard());
      return;
    }

    await bot.sendMessage(chatId, `Da them mon ${created.item.itemId} - ${created.item.name}.`, getAdminKeyboard());
  }));

  bot.onText(/^\/menuedit(?:\s+(.+))?$/i, safe(async (msg, match) => {
    const chatId = msg.chat.id;
    const rawArgs = match && match[1] ? match[1] : "";
    logCommand(chatId, "/menuedit", rawArgs);

    if (!isAdminChat(chatId)) {
      await bot.sendMessage(chatId, "Ban khong co quyen dung lenh nay.", getKeyboardByRole(chatId));
      return;
    }

    const parsed = parseMenuEditArgs(rawArgs);
    if (!parsed.ok) {
      await bot.sendMessage(chatId, parsed.error, getAdminKeyboard());
      return;
    }

    const updated = menuService.updateMenuItem(parsed.itemId, parsed.updates);
    if (!updated.ok) {
      await bot.sendMessage(chatId, updated.error, getAdminKeyboard());
      return;
    }

    try {
      await menuService.saveMenuToCsv();
    } catch (error) {
      await bot.sendMessage(chatId, `Da sua mon nhung luu CSV that bai: ${error.message}`, getAdminKeyboard());
      return;
    }

    await bot.sendMessage(chatId, `Da cap nhat ${updated.item.itemId} - ${updated.item.name}.`, getAdminKeyboard());
  }));

  bot.onText(/^\/menudelete(?:\s+([A-Za-z0-9]+))?$/i, safe(async (msg, match) => {
    const chatId = msg.chat.id;
    const itemId = match && match[1] ? match[1] : "";
    logCommand(chatId, "/menudelete", itemId);

    if (!isAdminChat(chatId)) {
      await bot.sendMessage(chatId, "Ban khong co quyen dung lenh nay.", getKeyboardByRole(chatId));
      return;
    }

    if (!itemId) {
      await bot.sendMessage(chatId, "Sai cu phap. Dung: /menudelete <item_id>", getAdminKeyboard());
      return;
    }

    const removed = menuService.removeMenuItem(itemId);
    if (!removed.ok) {
      await bot.sendMessage(chatId, removed.error, getAdminKeyboard());
      return;
    }

    try {
      await menuService.saveMenuToCsv();
    } catch (error) {
      await bot.sendMessage(chatId, `Da xoa mon nhung luu CSV that bai: ${error.message}`, getAdminKeyboard());
      return;
    }

    await bot.sendMessage(chatId, `Da xoa mon ${removed.item.itemId} - ${removed.item.name}.`, getAdminKeyboard());
  }));

  bot.onText(/^\/ai(?:\s+(.+))?$/i, safe(async (msg, match) => {
    const chatId = msg.chat.id;
    const content = match && match[1] ? match[1] : "";
    logCommand(chatId, "/ai", content);

    if (await denyBuyerFlowForAdmin(chatId)) {
      return;
    }

    if (getChatMode(chatId) !== MODES.AI) {
      await bot.sendMessage(chatId, "Hien dang o che do LIST. Dung /mode ai de bat AI mode truoc.");
      return;
    }

    if (!content) {
      await bot.sendMessage(chatId, "Dung: /ai <noi_dung>. Vi du: /ai cho minh 2 tra sua truyen thong size L");
      return;
    }

    const consumed = await tryAddFromAi(chatId, content);
    if (!consumed) {
      await bot.sendMessage(chatId, "AI chua parse duoc yeu cau nay. Ban thu /add theo ma mon nhe.");
    }
  }));

  bot.on("callback_query", async (query) => {
    const chatId = query && query.message && query.message.chat ? query.message.chat.id : null;
    const data = String(query.data || "");
    const messageId = query && query.message ? query.message.message_id : null;

    if (!chatId || (!data.startsWith("lf:") && !data.startsWith("ad:") && !data.startsWith("pm:"))) {
      return;
    }

    if (data.startsWith("pm:")) {
      try {
        const parts = data.split(":");
        const method = String(parts[1] || "").toLowerCase();
        const orderCode = String(parts[2] || "").toUpperCase();

        if (!orderCode) {
          await bot.answerCallbackQuery(query.id, { text: "Ma don khong hop le.", show_alert: true });
          return;
        }

        const order = await orderService.getOrderByCode(orderCode);
        if (!order) {
          await bot.answerCallbackQuery(query.id, { text: `Khong tim thay don ${orderCode}.`, show_alert: true });
          return;
        }

        if (!canManageOrder(chatId, order)) {
          await bot.answerCallbackQuery(query.id, { text: "Ban khong co quyen thao tac don nay.", show_alert: true });
          return;
        }

        if (method === "cod") {
          const choice = paymentService.choosePaymentMethod(orderCode, paymentService.PAYMENT_METHODS.COD);
          if (!choice.ok) {
            await bot.answerCallbackQuery(query.id, { text: choice.error, show_alert: true });
            return;
          }

          await orderService.setPaymentMethod(orderCode, choice.paymentMethod);
          await bot.answerCallbackQuery(query.id, { text: `Da chon COD cho ${orderCode}` });
          await bot.sendMessage(chatId, `Da chon COD cho don ${orderCode}.`);
          return;
        }

        if (method === "qr") {
          const choice = paymentService.choosePaymentMethod(orderCode, paymentService.PAYMENT_METHODS.QR);
          if (!choice.ok) {
            await bot.answerCallbackQuery(query.id, { text: choice.error, show_alert: true });
            return;
          }

          await orderService.setPaymentMethod(orderCode, choice.paymentMethod);
          const paymentLink = await paymentService.createPaymentLink(order);
          await orderService.saveOrderPayment(orderCode, paymentLink);

          await bot.answerCallbackQuery(query.id, { text: "Da tao link thanh toan PayOS" });
          await bot.sendMessage(chatId, buildPaymentLinkMessage(orderCode, paymentLink));
          return;
        }

        await bot.answerCallbackQuery(query.id);
        return;
      } catch (error) {
        logEvent("PAYMENT_CALLBACK_ERROR", {
          chatId,
          messageId,
          data,
          message: error.message,
          stack: error.stack,
        });

        try {
          await bot.answerCallbackQuery(query.id, { text: "Khong tao duoc thanh toan, vui long thu lai.", show_alert: true });
        } catch (answerError) {
          logEvent("CALLBACK_ANSWER_FAILED", { chatId, reason: answerError.message });
        }
        return;
      }
    }

    if (data.startsWith("ad:")) {
      if (!isAdminChat(chatId)) {
        try {
          await bot.answerCallbackQuery(query.id, { text: "Bạn không có quyền quản trị.", show_alert: true });
        } catch (error) {
          logEvent("CALLBACK_ANSWER_FAILED", { chatId, reason: error.message });
        }
        return;
      }

      try {
        const parts = data.split(":");
        const group = parts[1] || "";
        const action = parts[2] || "";

        if (group === "home") {
          await bot.answerCallbackQuery(query.id);
          await sendAdminDashboard(chatId);
          return;
        }

        if (group === "orders" && action === "list") {
          const page = Number.parseInt(parts[3], 10) || 0;
          await bot.answerCallbackQuery(query.id);
          await sendAdminOrdersList(chatId, page);
          return;
        }

        if (group === "orders" && action === "find") {
          await bot.answerCallbackQuery(query.id);
          saveAdminFlow(chatId, { action: "FIND_ORDER" });
          await bot.sendMessage(chatId, "Nhập mã đơn cần tìm (VD: ORDER0001)", getAdminKeyboard());
          return;
        }

        if (group === "order" && action === "view") {
          const orderCode = String(parts[3] || "").toUpperCase();
          await bot.answerCallbackQuery(query.id);
          await sendAdminOrderDetail(chatId, orderCode);
          return;
        }

        if (group === "order" && action === "delivered") {
          const orderCode = String(parts[3] || "").toUpperCase();
          const updated = await orderService.markOrderDelivered(orderCode);
          await bot.answerCallbackQuery(query.id);

          if (!updated) {
            await bot.sendMessage(chatId, `Không tìm thấy đơn ${orderCode}.`, getAdminKeyboard());
            return;
          }

          await bot.sendMessage(chatId, `Đã xác nhận đơn ${orderCode} đã giao.`, getAdminKeyboard());
          if (String(updated.chatId) !== String(chatId)) {
            await bot.sendMessage(updated.chatId, `Đơn ${orderCode} của bạn đã được giao thành công.`);
          }
          await sendAdminOrderDetail(chatId, orderCode);
          return;
        }

        if (group === "menu" && action === "list") {
          const page = Number.parseInt(parts[3], 10) || 0;
          await bot.answerCallbackQuery(query.id);
          await sendAdminMenuList(chatId, page);
          return;
        }

        if (group === "menu" && action === "view") {
          const itemId = parts[3] || "";
          await bot.answerCallbackQuery(query.id);
          await sendAdminMenuItemDetail(chatId, itemId);
          return;
        }

        if (group === "menu" && action === "toggle") {
          const itemId = parts[3] || "";
          const item = menuService.getItemByCode(itemId);
          await bot.answerCallbackQuery(query.id);

          if (!item) {
            await bot.sendMessage(chatId, `Không tìm thấy món ${itemId}.`, getAdminKeyboard());
            return;
          }

          const updated = menuService.updateMenuItem(itemId, { available: !item.available });
          if (!updated.ok) {
            await bot.sendMessage(chatId, `Không cập nhật được món: ${updated.error}`, getAdminKeyboard());
            return;
          }

          try {
            await menuService.saveMenuToCsv();
          } catch (error) {
            await bot.sendMessage(chatId, `Đã đổi trạng thái nhưng lưu CSV thất bại: ${error.message}`, getAdminKeyboard());
            return;
          }

          await sendAdminMenuItemDetail(chatId, itemId);
          return;
        }

        if (group === "menu" && action === "add") {
          await bot.answerCallbackQuery(query.id);
          saveAdminFlow(chatId, { action: "ADD_MENU", step: "itemId", draft: {} });
          await bot.sendMessage(chatId, "Nhập mã món mới (VD: TS20)", getAdminKeyboard());
          return;
        }

        if (group === "menu" && action === "edit") {
          const itemId = parts[4] || "";
          await bot.answerCallbackQuery(query.id);

          const item = menuService.getItemByCode(itemId);
          if (!item) {
            await bot.sendMessage(chatId, `Không tìm thấy món ${itemId}.`, getAdminKeyboard());
            return;
          }

          await bot.sendMessage(
            chatId,
            `Chọn trường cần sửa cho ${item.itemId} - ${item.name}`,
            buildAdminMenuEditFieldKeyboard(item.itemId)
          );
          return;
        }

        if (group === "menu" && action === "editfield") {
          const itemId = parts[3] || "";
          const field = parts[4] || "";
          await bot.answerCallbackQuery(query.id);

          const validFields = ["name", "category", "priceM", "priceL", "description", "available"];
          if (!validFields.includes(field)) {
            await bot.sendMessage(chatId, "Trường sửa không hợp lệ.", getAdminKeyboard());
            return;
          }

          saveAdminFlow(chatId, { action: "EDIT_MENU_FIELD", itemId, field });
          await bot.sendMessage(chatId, `Nhập giá trị mới cho ${field}:`, getAdminKeyboard());
          return;
        }

        if (group === "menu" && action === "delete") {
          const subAction = parts[3] || "";
          const itemId = parts[4] || "";

          if (subAction === "confirm") {
            await bot.answerCallbackQuery(query.id);
            await bot.sendMessage(
              chatId,
              `Bạn có chắc muốn xóa món ${itemId}?`,
              {
                reply_markup: {
                  inline_keyboard: [
                    [
                      { text: "✅ Xóa", callback_data: `ad:menu:delete:do:${itemId}` },
                      { text: "❌ Hủy", callback_data: `ad:menu:view:${itemId}` },
                    ],
                  ],
                },
              }
            );
            return;
          }

          if (subAction === "do") {
            await bot.answerCallbackQuery(query.id);
            const removed = menuService.removeMenuItem(itemId);
            if (!removed.ok) {
              await bot.sendMessage(chatId, removed.error, getAdminKeyboard());
              return;
            }

            try {
              await menuService.saveMenuToCsv();
            } catch (error) {
              await bot.sendMessage(chatId, `Đã xóa món nhưng lưu CSV thất bại: ${error.message}`, getAdminKeyboard());
              return;
            }

            await bot.sendMessage(chatId, `Đã xóa món ${itemId}.`, getAdminKeyboard());
            await sendAdminMenuList(chatId, 0);
            return;
          }
        }

        await bot.answerCallbackQuery(query.id);
        return;
      } catch (error) {
        logEvent("ADMIN_CALLBACK_ERROR", {
          chatId,
          messageId,
          data,
          message: error.message,
          stack: error.stack,
        });
        try {
          await bot.answerCallbackQuery(query.id, { text: "Đã có lỗi, vui lòng thử lại." });
        } catch (answerError) {
          logEvent("CALLBACK_ANSWER_FAILED", { chatId, reason: answerError.message });
        }
        await bot.sendMessage(chatId, "Có lỗi khi xử lý thao tác admin.", getAdminKeyboard());
        return;
      }
    }

    if (isAdminChat(chatId)) {
      try {
        await bot.answerCallbackQuery(query.id, {
          text: "Admin khong dung luong dat hang.",
          show_alert: false,
        });
      } catch (error) {
        logEvent("CALLBACK_ANSWER_FAILED", { chatId, reason: error.message });
      }

      await bot.sendMessage(
        chatId,
        "Tai khoan admin chi quan ly don/menu. Dung /help de xem lenh quan tri.",
        getAdminKeyboard()
      );
      return;
    }

    try {
      const parts = data.split(":");
      const action = parts[1] || "";

      if (action === "modepicker") {
        await bot.answerCallbackQuery(query.id);
        await sendModePicker(chatId);
        return;
      }

      if (action === "mode") {
        const nextMode = String(parts[2] || "").toUpperCase();
        const result = sessionService.setMode(chatId, nextMode);

        if (!result.ok) {
          await bot.answerCallbackQuery(query.id, { text: result.error, show_alert: true });
          return;
        }

        await bot.answerCallbackQuery(query.id, { text: `Da chuyen sang ${result.mode}` });

        if (result.mode === MODES.LIST) {
          await sendListMenu(chatId);
          return;
        }

        await bot.sendMessage(chatId, "Da chuyen sang che do AI. Ban co the nhap tu nhien de bot parse.", getMainKeyboard());
        return;
      }

      if (getChatMode(chatId) !== MODES.LIST) {
        await bot.answerCallbackQuery(query.id, { text: "Vui long chuyen sang LIST mode de dung cac nut nay." });
        return;
      }

      if (action === "list") {
        await bot.answerCallbackQuery(query.id);
        await sendListMenu(chatId);
        return;
      }

      if (action === "cart") {
        await bot.answerCallbackQuery(query.id);
        await sendCart(chatId);
        return;
      }

      if (action === "checkout") {
        await bot.answerCallbackQuery(query.id);
        await startCheckout(chatId);
        return;
      }

      if (action === "item") {
        const itemId = parts[2];
        await bot.answerCallbackQuery(query.id);
        await sendItemActions(chatId, itemId);
        return;
      }

      if (action === "desc") {
        const itemId = parts[2];
        const item = menuService.getItemByCode(itemId);
        await bot.answerCallbackQuery(query.id, {
          text: item ? item.description : "Khong tim thay mo ta.",
          show_alert: true,
        });
        return;
      }

      if (action === "price") {
        const itemId = parts[2];
        const item = menuService.getItemByCode(itemId);
        await bot.answerCallbackQuery(query.id, {
          text: item
            ? `Gia ${item.name}\nM: ${formatCurrencyVND(item.priceM)}\nL: ${formatCurrencyVND(item.priceL)}`
            : "Khong tim thay gia.",
          show_alert: true,
        });
        return;
      }

      if (action === "size") {
        const itemId = parts[2];
        const size = String(parts[3] || "M").toUpperCase() === "L" ? "L" : "M";
        const item = menuService.getItemByCode(itemId);

        if (!item) {
          await bot.answerCallbackQuery(query.id, { text: "Mon khong hop le.", show_alert: true });
          return;
        }

        saveListFlow(chatId, {
          itemId: item.itemId,
          size,
          quantity: null,
          selectedToppings: [],
        });

        await bot.answerCallbackQuery(query.id, { text: `Da chon size ${size}` });
        await bot.sendMessage(
          chatId,
          `Da chon ${item.name} size ${size}. Bam so luong mong muon:`,
          buildQuantityKeyboard(item.itemId, size)
        );
        return;
      }

      if (action === "qty") {
        const itemId = parts[2];
        const size = String(parts[3] || "M").toUpperCase() === "L" ? "L" : "M";
        const quantity = Number.parseInt(parts[4], 10);
        if (!Number.isInteger(quantity) || quantity <= 0) {
          await bot.answerCallbackQuery(query.id, { text: "So luong khong hop le.", show_alert: true });
          return;
        }

        saveListFlow(chatId, {
          itemId,
          size,
          quantity,
          selectedToppings: [],
        });

        await bot.answerCallbackQuery(query.id, { text: `Da chon so luong ${quantity}` });
        await sendToppingSelection(chatId);
        return;
      }

      if (action === "qtycustom") {
        const itemId = parts[2];
        const size = String(parts[3] || "M").toUpperCase() === "L" ? "L" : "M";
        const item = menuService.getItemByCode(itemId);

        if (!item) {
          await bot.answerCallbackQuery(query.id, { text: "Mon khong hop le.", show_alert: true });
          return;
        }

        saveListFlow(chatId, {
          itemId,
          size,
          quantity: null,
          selectedToppings: [],
          waitingCustomQuantity: true,
        });

        await bot.answerCallbackQuery(query.id);
        await bot.sendMessage(
          chatId,
          `Bạn đã chọn ${item.name} size ${size}.\nVui lòng nhập số lượng mong muốn (số nguyên > 0).`
        );
        return;
      }

      if (action === "qtyback") {
        const flow = getListFlow(chatId);
        if (!flow || !flow.itemId || !flow.size) {
          await bot.answerCallbackQuery(query.id, { text: "Khong tim thay buoc truoc." });
          await sendListMenu(chatId);
          return;
        }

        await bot.answerCallbackQuery(query.id);
        await bot.sendMessage(
          chatId,
          `Ban dang chon ${flow.itemId} size ${flow.size}. Bam lai so luong:`,
          buildQuantityKeyboard(flow.itemId, flow.size)
        );
        return;
      }

      if (action === "top") {
        const toppingId = parts[2];
        const flow = getListFlow(chatId);

        if (!flow || !flow.itemId || !flow.size || !flow.quantity) {
          await bot.answerCallbackQuery(query.id, { text: "Ban chua chon du thong tin mon." });
          await sendListMenu(chatId);
          return;
        }

        const exists = menuService.getItemByCode(toppingId);
        if (!exists || exists.category !== "Topping") {
          await bot.answerCallbackQuery(query.id, { text: "Topping khong hop le." });
          return;
        }

        const selected = new Set(flow.selectedToppings || []);
        if (selected.has(toppingId)) {
          selected.delete(toppingId);
        } else {
          selected.add(toppingId);
        }

        saveListFlow(chatId, { selectedToppings: Array.from(selected) });
        await bot.answerCallbackQuery(query.id);
        await sendToppingSelection(chatId, query.message.message_id);
        return;
      }

      if (action === "topskip") {
        await bot.answerCallbackQuery(query.id, { text: "Bo qua topping" });
        await finalizeListSelection(chatId, true);
        return;
      }

      if (action === "topdone") {
        await bot.answerCallbackQuery(query.id, { text: "Da chot topping, dang them vao gio" });
        await finalizeListSelection(chatId, false);
        return;
      }

      await bot.answerCallbackQuery(query.id);
    } catch (error) {
      logEvent("CALLBACK_ERROR", {
        chatId,
        data,
        message: error.message,
        stack: error.stack,
      });

      if (query && query.id) {
        try {
          await bot.answerCallbackQuery(query.id, { text: "Da co loi, vui long thu lai." });
        } catch (callbackError) {
          logEvent("CALLBACK_ANSWER_FAILED", { chatId, reason: callbackError.message });
        }
      }

      await bot.sendMessage(chatId, "Đã có lỗi xảy ra, bạn thử lại giúp mình nhé.");
    }
  });

  bot.on("message", safe(async (msg) => {
    const chatId = msg.chat.id;
    const text = String(msg.text || "").trim();

    if (!text) {
      return;
    }

    if (isAdminChat(chatId)) {
      if (text === "Đơn hàng") {
        await sendAdminOrdersList(chatId, 0);
        return;
      }

      if (text === "Menu quản lý") {
        await sendAdminMenuList(chatId, 0);
        return;
      }

      if (text === "Thêm món mới") {
        saveAdminFlow(chatId, { action: "ADD_MENU", step: "itemId", draft: {} });
        await bot.sendMessage(chatId, "Nhập mã món mới (VD: TS20)", getAdminKeyboard());
        return;
      }

      if (text === "Tìm đơn hàng") {
        saveAdminFlow(chatId, { action: "FIND_ORDER" });
        await bot.sendMessage(chatId, "Nhập mã đơn cần tìm (VD: ORDER0001)", getAdminKeyboard());
        return;
      }

      if (text === "Hướng dẫn admin") {
        await sendAdminHelp(chatId);
        return;
      }

      const consumedByAdminFlow = await handleAdminFlowInput(chatId, text);
      if (consumedByAdminFlow) {
        return;
      }
    }

    if (isAdminChat(chatId) && ["Xem menu", "Xem giỏ hàng", "Checkout", "Chế độ LIST", "Chế độ AI"].includes(text)) {
      await denyBuyerFlowForAdmin(chatId);
      return;
    }

    if (text === "Xem menu") {
      await sendMenu(chatId);
      return;
    }

    if (text === "Xem đơn hàng") {
      if (!isAdminChat(chatId)) {
        await bot.sendMessage(chatId, "Ban khong co quyen dung lenh nay.", getKeyboardByRole(chatId));
        return;
      }

      await sendAdminOrdersList(chatId, 0);
      return;
    }

    if (text === "Xem menu admin") {
      if (!isAdminChat(chatId)) {
        await bot.sendMessage(chatId, "Ban khong co quyen dung lenh nay.", getKeyboardByRole(chatId));
        return;
      }

      await sendAdminMenuList(chatId, 0);
      return;
    }

    if (text === "Hướng dẫn admin") {
      if (!isAdminChat(chatId)) {
        await bot.sendMessage(chatId, "Ban khong co quyen dung lenh nay.", getKeyboardByRole(chatId));
        return;
      }

      await sendAdminHelp(chatId);
      return;
    }

    if (text === "Xem giỏ hàng") {
      await sendCart(chatId);
      return;
    }

    if (text === "Checkout") {
      await startCheckout(chatId);
      return;
    }

    if (text === "Chế độ LIST") {
      const result = sessionService.setMode(chatId, MODES.LIST);
      if (!result.ok) {
        await bot.sendMessage(chatId, result.error, getMainKeyboard());
        return;
      }

      await bot.sendMessage(
        chatId,
        "Đã chuyển sang chế độ LIST. Mình sẽ dẫn bạn chọn món theo từng bước bằng nút bấm.",
        getKeyboardByRole(chatId)
      );
      await sendListMenu(chatId);
      return;
    }

    if (text === "Chế độ AI") {
      const result = sessionService.setMode(chatId, MODES.AI);
      if (!result.ok) {
        await bot.sendMessage(chatId, result.error, getMainKeyboard());
        return;
      }

      await bot.sendMessage(
        chatId,
        "Đã chuyển sang chế độ AI. Bạn có thể nhập tự nhiên để bot parse.",
        getKeyboardByRole(chatId)
      );
      return;
    }

    if (text.startsWith("/")) {
      return;
    }

    if (isAdminChat(chatId)) {
      await bot.sendMessage(
        chatId,
        "Admin chi dung chuc nang quan tri. Dung /help de xem cac lenh quan tri.",
        getAdminKeyboard()
      );
      return;
    }

    const listFlow = getListFlow(chatId);
    if (getChatMode(chatId) === MODES.LIST && listFlow && listFlow.waitingCustomQuantity) {
      const quantity = Number.parseInt(text, 10);
      if (!Number.isInteger(quantity) || quantity <= 0) {
        await bot.sendMessage(chatId, "Số lượng không hợp lệ. Vui lòng nhập số nguyên lớn hơn 0.");
        return;
      }

      saveListFlow(chatId, {
        quantity,
        waitingCustomQuantity: false,
      });

      await bot.sendMessage(chatId, `Đã nhận số lượng ${quantity}. Tiếp theo mời bạn chọn topping:`);
      await sendToppingSelection(chatId);
      return;
    }

    const state = sessionService.getSession(chatId).state;
    if (state !== STATES.IDLE) {
      await handleCheckoutStateMessage(chatId, text);
      return;
    }

    if (getChatMode(chatId) !== MODES.AI) {
      await bot.sendMessage(
        chatId,
        "Ban dang o che do LIST. Dung /menu de xem mon, hoac /mode ai neu muon nhap ngon ngu tu nhien.",
        getKeyboardByRole(chatId)
      );
      return;
    }

    const consumedByAi = await tryAddFromAi(chatId, text);
    if (consumedByAi) {
      return;
    }

    await bot.sendMessage(chatId, "Mình chưa hiểu ý bạn. Dùng /help để xem lệnh hỗ trợ nhé.", getKeyboardByRole(chatId));
  }));
}

module.exports = {
  setupBotHandlers,
};
