const OpenAI = require("openai");
const Fuse = require("fuse.js");

const AI_INTENTS = [
  "add_to_cart",
  "update_cart",
  "checkout",
  "show_menu",
  "show_cart",
  "show_item_description",
  "show_item_price",
  "clear_cart",
  "help",
  "switch_mode",
  "unknown",
];

const AI_ACTIONS = [
  "add",
  "set_quantity",
  "remove",
  "add_toppings",
  "remove_toppings",
  "replace_toppings",
];

const AI_OUTPUT_SCHEMA_DEF = {
  type: "object",
  properties: {
    intent: {
      type: "string",
      enum: AI_INTENTS,
    },
    mode: {
      anyOf: [
        { type: "string", enum: ["LIST", "AI"] },
        { type: "null" },
      ],
    },
    targetIndex: {
      anyOf: [{ type: "number" }, { type: "null" }],
    },
    targetItemName: {
      anyOf: [{ type: "string" }, { type: "null" }],
    },
    checkoutInfo: {
      anyOf: [
        {
          type: "object",
          properties: {
            customerName: { type: "string" },
            phone: { type: "string" },
            deliveryMethod: {
              type: "string",
              enum: ["pickup", "delivery", ""],
            },
            address: { type: "string" },
            note: { type: "string" },
          },
          required: ["customerName", "phone", "deliveryMethod", "address", "note"],
          additionalProperties: false,
        },
        { type: "null" },
      ],
    },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          action: { type: "string", enum: AI_ACTIONS },
          targetItemId: { anyOf: [{ type: "string" }, { type: "null" }] },
          targetItemName: { anyOf: [{ type: "string" }, { type: "null" }] },
          itemId: { anyOf: [{ type: "string" }, { type: "null" }] },
          itemName: { anyOf: [{ type: "string" }, { type: "null" }] },
          size: {
            anyOf: [
              { type: "string", enum: ["M", "L"] },
              { type: "null" },
            ],
          },
          quantity: { anyOf: [{ type: "number" }, { type: "null" }] },
          toppings: {
            type: "array",
            items: { type: "string" },
          },
          note: { type: "string" },
        },
        required: [
          "action",
          "targetItemId",
          "targetItemName",
          "itemId",
          "itemName",
          "size",
          "quantity",
          "toppings",
          "note",
        ],
        additionalProperties: false,
      },
    },
    missingFields: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: ["intent", "items", "missingFields"],
  additionalProperties: false,
};

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();
}

function cleanUserText(value) {
  return normalizeText(value)
    .replace(/\bxau\b/g, "xay")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseQuantity(text) {
  const normalized = cleanUserText(text);
  const numberMatch = normalized.match(/\b(\d{1,2})\b/);
  if (numberMatch) {
    const quantity = Number.parseInt(numberMatch[1], 10);
    if (Number.isInteger(quantity) && quantity > 0) {
      return quantity;
    }
  }

  if (/\b(mot|motly|motcoc|một)\b/.test(normalized)) {
    return 1;
  }

  if (/\b(hai|2ly|2coc)\b/.test(normalized)) {
    return 2;
  }

  if (/\b(ba|3ly|3coc)\b/.test(normalized)) {
    return 3;
  }

  return null;
}

function parseSize(text) {
  const normalized = cleanUserText(text);
  if (/\b(size\s*(m|vua|vừa|nho|nhỏ)|ly\s*(m|vua|vừa|nho|nhỏ)|vua|vừa|nho|nhỏ)\b/.test(normalized)) {
    return "M";
  }

  if (/\b(size\s*(l|lon|lớn)|ly\s*(l|lon|lớn)|lon|lớn|to)\b/.test(normalized)) {
    return "L";
  }

  const sizeMatch = normalized.match(/\bsize\s*(m|l)\b|\b(m|l)\b/);
  if (!sizeMatch) {
    return null;
  }

  return (sizeMatch[1] || sizeMatch[2] || "").toUpperCase() || null;
}

function parsePhone(text) {
  const compact = String(text || "")
    .replace(/[^0-9+]/g, "")
    .replace(/^\+84/, "0")
    .replace(/^84/, "0");

  const match = compact.match(/0\d{9}/);
  return match ? match[0] : null;
}

function parseDeliveryMethodFromText(text) {
  const normalized = cleanUserText(text);
  if (/\b(giao hang|delivery|ship|ship hang|mang den)\b/.test(normalized)) {
    return "delivery";
  }

  if (/\b(pickup|nhan tai quan|lay tai quan|den lay)\b/.test(normalized)) {
    return "pickup";
  }

  return null;
}

function parseAddress(text) {
  const raw = String(text || "");
  const markerMatch = raw.match(/(?:dia\s*chi|địa\s*chỉ)\s*[:\-]?\s*(.+)$/i);
  if (markerMatch && markerMatch[1]) {
    return markerMatch[1].trim();
  }

  if (/\b(giao hang|delivery|ship)\b/i.test(raw) && raw.trim().length > 12) {
    return raw.trim();
  }

  return "";
}

function parseCustomerName(text) {
  const raw = String(text || "").trim();
  const byMarker = raw.match(/(?:ten|tên)\s*(?:toi|tôi|nguoi nhan|người nhận)?\s*[:\-]?\s*([\p{L}\s]{2,40})/iu);
  if (byMarker && byMarker[1]) {
    return byMarker[1].trim();
  }

  const byIntro = raw.match(/(?:toi la|tôi là|mình là)\s+([\p{L}\s]{2,40})/iu);
  if (byIntro && byIntro[1]) {
    return byIntro[1].trim();
  }

  return "";
}

function parseTargetIndex(text) {
  const normalized = cleanUserText(text);
  const match = normalized.match(/(?:#\s*(\d{1,3})\b)|\b(?:so|so thu|mon|mon so|mon thu|muc|item|thu)\s*(\d{1,3})\b/);
  if (!match) {
    return null;
  }

  const index = Number.parseInt(match[1] || match[2], 10);
  return Number.isInteger(index) && index > 0 ? index : null;
}

function scoreByTokenOverlap(userText, itemName) {
  const stopWords = new Set([
    "cho",
    "minh",
    "mình",
    "toi",
    "toi",
    "lay",
    "them",
    "size",
    "ly",
    "coc",
    "mot",
    "một",
    "nhe",
    "voi",
    "với",
  ]);

  const userTokens = cleanUserText(userText)
    .split(" ")
    .filter((token) => token && !stopWords.has(token));
  const itemTokens = cleanUserText(itemName).split(" ").filter(Boolean);

  if (userTokens.length === 0 || itemTokens.length === 0) {
    return 0;
  }

  let hit = 0;
  for (const token of userTokens) {
    if (itemTokens.some((itemToken) => itemToken.includes(token) || token.includes(itemToken))) {
      hit += 1;
    }
  }

  const overlapScore = hit / userTokens.length;
  const containsScore = cleanUserText(userText).includes(cleanUserText(itemName)) ? 0.2 : 0;
  return Math.min(1, overlapScore + containsScore);
}

function resolveBestMenuItem(message, menu) {
  const list = Array.isArray(menu) ? menu : [];
  if (list.length === 0) {
    return null;
  }

  const scored = list
    .map((item) => ({
      item,
      score: scoreByTokenOverlap(message, item.name),
    }))
    .sort((a, b) => b.score - a.score);

  if (!scored[0] || scored[0].score < 0.5) {
    return null;
  }

  return scored[0].item;
}

function getOpenAiClient() {
  const key = String(process.env.OPENAI_API_KEY || "").trim();
  if (!key) {
    return null;
  }

  // Skip obvious placeholder values to avoid unnecessary 401 errors.
  const looksLikePlaceholder =
    key.toLowerCase().includes("your_api") ||
    key.toLowerCase().includes("replace_me") ||
    key.toLowerCase().includes("example") ||
    key.length < 20;

  if (looksLikePlaceholder) {
    return null;
  }

  return new OpenAI({ apiKey: key });
}

function buildMenuPrompt(menu) {
  return (Array.isArray(menu) ? menu : [])
    .map((item) => `${item.itemId} | ${item.name} | ${item.category}`)
    .join("\n");
}

function buildRelevantMenu(message, menu, maxItems = 10) {
  const list = Array.isArray(menu) ? menu.filter(Boolean) : [];
  if (!list.length) {
    return [];
  }

  // Keep full menu for small catalogs.
  if (list.length <= 50) {
    return list;
  }

  const fuse = new Fuse(list, {
    keys: ["name", "itemId", "category"],
    includeScore: true,
    threshold: 0.4,
    ignoreLocation: true,
  });

  const raw = String(message || "").trim();
  const results = fuse.search(raw, { limit: maxItems });
  const picked = results.map((entry) => entry.item);
  if (!picked.length) {
    return list.slice(0, maxItems);
  }

  return picked;
}

function normalizeChatHistory(chatHistory = []) {
  if (!Array.isArray(chatHistory)) {
    return [];
  }

  return chatHistory
    .filter((entry) => entry && (entry.role === "user" || entry.role === "assistant") && entry.content)
    .slice(-6)
    .map((entry) => ({
      role: entry.role,
      content: String(entry.content).slice(0, 800),
    }));
}

function parseFallback(message, menu) {
  const normalized = cleanUserText(message);

  if (/\b(menu|thuc don|danh sach mon|xem mon|co mon gi|co gi ngon|goi y mon|quan co gi)\b/.test(normalized)) {
    return {
      intent: "show_menu",
      items: [],
      missingFields: [],
    };
  }

  if (/\b(mo ta|mota|chi tiet mon|gioi thieu mon|thong tin mon|review mon)\b/.test(normalized)) {
    return {
      intent: "show_item_description",
      targetIndex: parseTargetIndex(message),
      targetItemName: "",
      items: [],
      missingFields: [],
    };
  }

  if (/\b(gia mon|xem gia|bao gia|gia cua mon|gia so|bang gia|bao nhieu tien|het bao nhieu)\b/.test(normalized)) {
    return {
      intent: "show_item_price",
      targetIndex: parseTargetIndex(message),
      targetItemName: "",
      items: [],
      missingFields: [],
    };
  }

  if (/\b(gio hang|xem gio|cart|gio cua toi|gio con gi|xem don tam)\b/.test(normalized)) {
    return {
      intent: "show_cart",
      items: [],
      missingFields: [],
    };
  }

  if (/\b(checkout|thanh toan|chot don|dat hang|len don|xac nhan don|giao hang luon)\b/.test(normalized)) {
    const checkoutInfo = {
      customerName: parseCustomerName(message),
      phone: parsePhone(message),
      deliveryMethod: parseDeliveryMethodFromText(message),
      address: parseAddress(message),
      note: "",
    };

    const missingFields = [];
    if (!checkoutInfo.customerName) {
      missingFields.push("customerName");
    }
    if (!checkoutInfo.phone) {
      missingFields.push("phone");
    }
    if (!checkoutInfo.deliveryMethod) {
      missingFields.push("deliveryMethod");
    }
    if (checkoutInfo.deliveryMethod === "delivery" && !checkoutInfo.address) {
      missingFields.push("address");
    }

    return {
      intent: "checkout",
      checkoutInfo,
      items: [],
      missingFields,
    };
  }

  if (/\b(giao hang cho toi|giao cho toi|ship cho toi|mang den cho toi|giao toi dia chi)\b/.test(normalized)) {
    const checkoutInfo = {
      customerName: parseCustomerName(message),
      phone: parsePhone(message),
      deliveryMethod: "delivery",
      address: parseAddress(message),
      note: "",
    };

    const missingFields = [];
    if (!checkoutInfo.customerName) {
      missingFields.push("customerName");
    }
    if (!checkoutInfo.phone) {
      missingFields.push("phone");
    }
    if (!checkoutInfo.address) {
      missingFields.push("address");
    }

    return {
      intent: "checkout",
      checkoutInfo,
      items: [],
      missingFields,
    };
  }

  if (/\b(xoa het gio|xoa gio|clear cart|lam trong gio|reset gio|huy gio)\b/.test(normalized)) {
    return {
      intent: "clear_cart",
      items: [],
      missingFields: [],
    };
  }

  if (/\b(help|huong dan|tro giup|giup toi|huong dan dat mon|chi toi cach dat)\b/.test(normalized)) {
    return {
      intent: "help",
      items: [],
      missingFields: [],
    };
  }

  if (/\b(chuyen mode|mode|che do|doi che do|ve che do|qua che do)\b/.test(normalized) && /\b(list|ai|nut bam|tu nhien)\b/.test(normalized)) {
    return {
      intent: "switch_mode",
      mode: /\blist\b|\bnut bam\b/.test(normalized) ? "LIST" : "AI",
      items: [],
      missingFields: [],
    };
  }
  const segments = normalized.split(/\bva\b|,|\bvoi\b/).map((part) => part.trim()).filter(Boolean);
  const candidates = segments.length > 1 ? segments : [message];
  const items = [];

  for (const candidate of candidates) {
    const quantity = parseQuantity(candidate) || parseQuantity(message) || 1;
    const size = parseSize(candidate) || parseSize(message) || null;
    const bestItem = resolveBestMenuItem(candidate, menu);
    if (!bestItem) {
      continue;
    }

    items.push({
      action: "add",
      itemId: bestItem.itemId,
      itemName: bestItem.name,
      quantity,
      size,
      toppings: [],
      note: "",
    });
  }

  if (items.length > 0) {
    return {
      intent: "add_to_cart",
      items,
      missingFields: [],
    };
  }

  const looksLikeUpdate = /\b(giam|bot|xoa|bo|doi|thay|tang|them topping|bo topping)\b/.test(normalized) && /\b(gio|mon|topping|dong)\b/.test(normalized);
  if (looksLikeUpdate) {
    return {
      intent: "update_cart",
      items: [],
      missingFields: ["target_item"],
    };
  }

  return {
    intent: "unknown",
    items: [],
    missingFields: ["item", "size", "quantity"],
  };
}

async function parseWithOpenAi(message, menu, chatHistory = []) {
  const client = getOpenAiClient();
  if (!client) {
    return null;
  }

  const relevantMenu = buildRelevantMenu(message, menu, Number(process.env.AI_MENU_CONTEXT_LIMIT || 10));
  const menuText = buildMenuPrompt(relevantMenu);
  const historyMessages = normalizeChatHistory(chatHistory);

  const response = await client.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: [
          "Bạn là trợ lý nhận order trà sữa.",
          "Phân tích câu nói của khách và trả về JSON chính xác theo schema.",
          "Không tự bịa tên món không có trong Menu.",
          "Nếu khách nói nhiều món trong một câu, tách thành nhiều phần tử trong items.",
          "Nếu thiếu thông tin thì điền missingFields hợp lý.",
        ].join(" "),
      },
      {
        role: "user",
        content: "Menu:\nTS01 | Trà Sữa Trân Châu | Trà Sữa\nTP01 | Pudding | Topping\n\nTin nhắn khách:\ncho 2 ly trà sữa trân châu size L thêm pudding nha",
      },
      {
        role: "assistant",
        content: JSON.stringify({
          intent: "add_to_cart",
          mode: null,
          targetIndex: null,
          targetItemName: null,
          checkoutInfo: null,
          items: [
            {
              action: "add",
              targetItemId: null,
              targetItemName: null,
              itemId: "TS01",
              itemName: "Trà Sữa Trân Châu",
              size: "L",
              quantity: 2,
              toppings: ["pudding"],
              note: "",
            },
          ],
          missingFields: [],
        }),
      },
      {
        role: "user",
        content: "Menu:\nCF01 | Cà Phê Đen | Cà Phê\n\nTin nhắn khách:\ngiao mình tới 268 Lý Thường Kiệt nha, sđt 0901234567, mình tên Danh",
      },
      {
        role: "assistant",
        content: JSON.stringify({
          intent: "checkout",
          mode: null,
          targetIndex: null,
          targetItemName: null,
          checkoutInfo: {
            customerName: "Danh",
            phone: "0901234567",
            deliveryMethod: "delivery",
            address: "268 Lý Thường Kiệt",
            note: "",
          },
          items: [],
          missingFields: [],
        }),
      },
      ...historyMessages,
      {
        role: "user",
        content: `Menu:\n${menuText}\n\nTin nhan khach:\n${message}`,
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "parse_milk_tea_order",
        strict: true,
        schema: AI_OUTPUT_SCHEMA_DEF,
      },
    },
    temperature: 0,
  });

  const content = response.choices && response.choices[0] && response.choices[0].message
    ? response.choices[0].message.content
    : null;
  const output = content ? JSON.parse(content) : null;
  if (!output || typeof output !== "object") {
    return null;
  }

  return {
    intent: output.intent || "unknown",
    mode: output.mode || null,
    checkoutInfo: output.checkoutInfo && typeof output.checkoutInfo === "object" ? output.checkoutInfo : null,
    targetIndex: output.targetIndex || null,
    targetItemName: output.targetItemName || null,
    items: Array.isArray(output.items) ? output.items : [],
    missingFields: Array.isArray(output.missingFields) ? output.missingFields : [],
  };
}

// Keep validation and pricing in backend services.
async function parseOrderMessage(message, menu, chatHistory = []) {
  if (String(process.env.ENABLE_AI || "false").toLowerCase() !== "true") {
    return parseFallback(message, menu);
  }

  try {
    const aiResult = await parseWithOpenAi(message, menu, chatHistory);
    if (aiResult) {
      const normalized = normalizeText(message);
      const hasMultiItemHint = /\bva\b|\bvoi\b|,/.test(normalized);
      if (hasMultiItemHint && aiResult.intent === "add_to_cart" && (!Array.isArray(aiResult.items) || aiResult.items.length <= 1)) {
        const fallback = parseFallback(message, menu);
        if (fallback.intent === "add_to_cart" && Array.isArray(fallback.items) && fallback.items.length > 1) {
          return fallback;
        }
      }

      if (["show_item_description", "show_item_price"].includes(aiResult.intent)) {
        const hasTarget = Number.isInteger(Number.parseInt(aiResult.targetIndex, 10)) || String(aiResult.targetItemName || "").trim().length > 0;
        if (!hasTarget) {
          const fallback = parseFallback(message, menu);
          if (fallback.intent === aiResult.intent && (fallback.targetIndex || fallback.targetItemName)) {
            return {
              ...aiResult,
              targetIndex: fallback.targetIndex || null,
              targetItemName: fallback.targetItemName || null,
            };
          }
        }
      }

      return aiResult;
    }
  } catch (error) {
    console.error("AI parse failed, fallback to heuristic parser:", error.message);
  }

  return parseFallback(message, menu);
}

const AI_OUTPUT_SCHEMA = {
  intent: "add_to_cart | update_cart | checkout | show_menu | show_cart | show_item_description | show_item_price | clear_cart | help | switch_mode | unknown",
  mode: "LIST | AI",
  targetIndex: 1,
  targetItemName: "string",
  checkoutInfo: {
    customerName: "string",
    phone: "string",
    deliveryMethod: "pickup|delivery",
    address: "string",
    note: "string",
  },
  items: [
    {
      action: "add | set_quantity | remove | add_toppings | remove_toppings | replace_toppings",
      targetItemId: "string",
      targetItemName: "string",
      itemId: "string",
      itemName: "string",
      size: "M|L",
      quantity: 1,
      toppings: ["string"],
      note: "",
    },
  ],
  missingFields: ["string"],
};

module.exports = {
  normalizeText,
  parseOrderMessage,
  AI_OUTPUT_SCHEMA,
  AI_OUTPUT_SCHEMA_DEF,
};
