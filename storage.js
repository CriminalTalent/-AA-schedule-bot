// ============================================================
// storage.js — 플레이어 데이터 JSON 파일 저장/불러오기
// ============================================================
import fs   from "fs";
import path from "path";
import { INITIAL_STATS, INITIAL_HIDDEN } from "./game.js";

const DATA_PATH = process.env.DATA_PATH ?? "./data/players.json";
const MAX_TURNS = Number(process.env.MAX_TURNS ?? 24);

function ensureDir() {
  const dir = path.dirname(DATA_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function load() {
  ensureDir();
  if (!fs.existsSync(DATA_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(DATA_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function save(data) {
  ensureDir();
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), "utf-8");
}

export function getPlayer(accountId, displayName) {
  const data = load();
  if (!data[accountId]) {
    data[accountId] = {
      accountId,
      name:      displayName,
      stats:     { ...INITIAL_STATS },
      hidden:    { ...INITIAL_HIDDEN },
      gold:      500,
      inventory: [],
      equipped:  {},
      turn:      1,
      history:   [],
    };
    save(data);
  }
  return data[accountId];
}

export function updatePlayer(player) {
  const data = load();
  data[player.accountId] = player;
  save(data);
}

export function getAllPlayers() {
  return Object.values(load());
}

export function processPlayer(accountId, applyFn) {
  const data = load();
  if (!data[accountId]) return null;
  const processed   = applyFn(data[accountId]);
  data[accountId]   = processed;
  save(data);
  return processed;
}

export function hasSubmittedThisTurn(accountId, displayName) {
  const player = getPlayer(accountId, displayName);
  const last   = player.history.at(-1);
  return last?.turn === player.turn - 1;
}

export function isEnded(accountId, displayName) {
  const player = getPlayer(accountId, displayName);
  return player.turn > MAX_TURNS;
}
