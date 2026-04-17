const Redis = require("ioredis");

const STATES = {
  IDLE: "IDLE",
  WAITING_NAME: "WAITING_NAME",
  WAITING_PHONE: "WAITING_PHONE",
  WAITING_DELIVERY_METHOD: "WAITING_DELIVERY_METHOD",
  WAITING_ADDRESS: "WAITING_ADDRESS",
  WAITING_NOTE: "WAITING_NOTE",
  CONFIRMING_ORDER: "CONFIRMING_ORDER",
  WAITING_PAYMENT: "WAITING_PAYMENT",
};

const MODES = {
  LIST: "LIST",
  AI: "AI",
};

const sessions = new Map();
let redisClient = null;
let redisEnabled = false;

function getRedisKey(chatId) {
  return `buyer:session:${chatId}`;
}

function getSessionTtlSeconds() {
  return Number(process.env.REDIS_SESSION_TTL_SECONDS || 60 * 60 * 24);
}

function getDefaultSession() {
  return {
    state: STATES.IDLE,
    mode: MODES.LIST,
    data: {},
    updatedAt: new Date().toISOString(),
  };
}

function cloneSession(session) {
  return {
    state: session.state,
    mode: session.mode,
    data: { ...(session.data || {}) },
    updatedAt: session.updatedAt,
  };
}

async function initialize() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    redisEnabled = false;
    return { enabled: false, reason: "Missing REDIS_URL" };
  }

  if (redisClient) {
    return { enabled: redisEnabled };
  }

  redisClient = new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });

  try {
    await redisClient.connect();
    await redisClient.ping();
    redisEnabled = true;
    return { enabled: true };
  } catch (error) {
    redisEnabled = false;
    return { enabled: false, reason: error.message };
  }
}

async function writeRedisSession(chatId, session) {
  if (!redisEnabled || !redisClient) {
    return;
  }

  try {
    await redisClient.set(getRedisKey(chatId), JSON.stringify(session), "EX", getSessionTtlSeconds());
  } catch (error) {
    // ignore redis write failures to keep bot flow responsive
  }
}

async function tryHydrateFromRedis(chatId) {
  if (!redisEnabled || !redisClient || sessions.has(chatId)) {
    return;
  }

  try {
    const raw = await redisClient.get(getRedisKey(chatId));
    if (!raw) {
      return;
    }

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return;
    }

    sessions.set(chatId, {
      ...getDefaultSession(),
      ...parsed,
      data: { ...(parsed.data || {}) },
    });
  } catch (error) {
    // ignore redis read failures
  }
}

function touchSession(session) {
  session.updatedAt = new Date().toISOString();
}

function getSession(chatId) {
  if (!sessions.has(chatId)) {
    void tryHydrateFromRedis(chatId);
  }

  return cloneSession(sessions.get(chatId) || getDefaultSession());
}

function setState(chatId, state) {
  const current = sessions.get(chatId) || getDefaultSession();
  current.state = state;
  touchSession(current);
  sessions.set(chatId, current);
  void writeRedisSession(chatId, current);
  return cloneSession(current);
}

function mergeData(chatId, partialData) {
  const current = sessions.get(chatId) || getDefaultSession();
  current.data = {
    ...current.data,
    ...partialData,
  };
  touchSession(current);
  sessions.set(chatId, current);
  void writeRedisSession(chatId, current);
  return cloneSession(current);
}

function resetSession(chatId) {
  const current = sessions.get(chatId);
  const next = getDefaultSession();

  if (current && current.mode) {
    next.mode = current.mode;
  }

  sessions.set(chatId, next);
  void writeRedisSession(chatId, next);
}

function getMode(chatId) {
  const session = sessions.get(chatId) || getDefaultSession();
  return session.mode || MODES.LIST;
}

function setMode(chatId, mode) {
  const current = sessions.get(chatId) || getDefaultSession();
  const upperMode = String(mode || "").toUpperCase();

  if (!Object.values(MODES).includes(upperMode)) {
    return {
      ok: false,
      error: "Mode khong hop le. Chi nhan LIST hoac AI.",
    };
  }

  current.mode = upperMode;
  touchSession(current);
  sessions.set(chatId, current);
  void writeRedisSession(chatId, current);

  return {
    ok: true,
    mode: upperMode,
  };
}

module.exports = {
  STATES,
  MODES,
  initialize,
  getSession,
  setState,
  mergeData,
  resetSession,
  getMode,
  setMode,
};
