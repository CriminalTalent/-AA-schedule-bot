// ============================================================
// storage.js — 플레이어 데이터 관리 (Google Sheets 기반)
// ============================================================
import { INITIAL_STATS, INITIAL_HIDDEN } from "./game.js";
import {
  loadPlayer,
  loadAllPlayers,
  savePlayer,
} from "./sheets.js";

const MAX_TURNS = Number(process.env.MAX_TURNS ?? 24);

// ── 플레이어 기본 CRUD ────────────────────────────────────────

export async function getPlayer(accountId, displayName) {
  let player = await loadPlayer(accountId);

  if (!player) {
    player = {
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
    await savePlayer(player);
  }

  return player;
}

export async function updatePlayer(player) {
  await savePlayer(player);
}

export async function getAllPlayers() {
  const map = await loadAllPlayers();
  return Object.values(map);
}

// ── 스케줄 봇용 ──────────────────────────────────────────────

// 마지막 history의 turn이 현재 turn - 1이면 이미 제출한 것
export async function hasSubmittedThisTurn(accountId, displayName) {
  const player = await getPlayer(accountId, displayName);
  const last   = player.history.at(-1);
  return last?.turn === player.turn - 1;
}

export async function isEnded(accountId, displayName) {
  const player = await getPlayer(accountId, displayName);
  return player.turn > MAX_TURNS;
}
