const OpenAI = require("openai");

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

  return null;
}

function parseSize(text) {
  const normalized = cleanUserText(text);
  const sizeMatch = normalized.match(/\bsize\s*(m|l)\b|\b(m|l)\b/);
  if (!sizeMatch) {
    return null;
  }

  return (sizeMatch[1] || sizeMatch[2] || "").toUpperCase() || null;
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

function parseFallback(message, menu) {
  const normalized = cleanUserText(message);
  const quantity = parseQuantity(message);
  const size = parseSize(message);

  const bestItem = resolveBestMenuItem(normalized, menu);
  if (bestItem) {
    const missingFields = [];
    if (!size) {
      missingFields.push("size");
    }
    if (!quantity) {
      missingFields.push("quantity");
    }

    return {
      intent: "add_to_cart",
      items: [
        {
          itemId: bestItem.itemId,
          itemName: bestItem.name,
          quantity: quantity || 1,
          size,
          toppings: [],
          note: "",
        },
      ],
      missingFields,
    };
  }

  return {
    intent: "unknown",
    items: [],
    missingFields: ["item", "size", "quantity"],
  };
}

async function parseWithOpenAi(message, menu) {
  const client = getOpenAiClient();
  if (!client) {
    return null;
  }

  const menuText = buildMenuPrompt(menu);
  const response = await client.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
    messages: [
      {
        role: "system",
        content:
          "Ban la parser dat mon cho quan tra sua. Tra ve DUY NHAT JSON hop le voi schema {intent, items, missingFields}. Khong tinh tien. Khong tao mon khong co trong menu.",
      },
      {
        role: "user",
        content: `Menu:\n${menuText}\n\nTin nhan khach:\n${message}`,
      },
    ],
    response_format: { type: "json_object" },
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
    items: Array.isArray(output.items) ? output.items : [],
    missingFields: Array.isArray(output.missingFields) ? output.missingFields : [],
  };
}

// Keep validation and pricing in backend services.
async function parseOrderMessage(message, menu) {
  if (String(process.env.ENABLE_AI || "false").toLowerCase() !== "true") {
    return parseFallback(message, menu);
  }

  try {
    const aiResult = await parseWithOpenAi(message, menu);
    if (aiResult) {
      return aiResult;
    }
  } catch (error) {
    console.error("AI parse failed, fallback to heuristic parser:", error.message);
  }

  return parseFallback(message, menu);
}

const AI_OUTPUT_SCHEMA = {
  intent: "add_to_cart | checkout | unknown",
  items: [
    {
      itemId: "string",
      itemName: "string",
      size: "M|L",
      quantity: 1,
      toppings: [],
      note: "",
    },
  ],
  missingFields: ["string"],
};

module.exports = {
  normalizeText,
  parseOrderMessage,
  AI_OUTPUT_SCHEMA,
};
