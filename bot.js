// ============================================================
// bot.js — 왕립 계승 아카데미 스케줄 봇
// ============================================================
import "dotenv/config";
import { createRestAPIClient, createStreamingAPIClient } from "masto";
import {
  applyActions,
  buildStatusLine,
  validateSchedule,
  getAge,
} from "./game.js";
import {
  getPlayer,
  updatePlayer,
  getAllPlayers,
  processPlayer,
  hasSubmittedThisTurn,
  isEnded,
} from "./storage.js";

const GM_ID        = process.env.GM_ACCOUNT_ID ?? "";
const BOT_TOKEN    = process.env.MASTODON_TOKEN;
const INSTANCE_URL = process.env.MASTODON_URL;
const MAX_TURNS    = Number(process.env.MAX_TURNS ?? 24);

if (!BOT_TOKEN || !INSTANCE_URL) {
  console.error(".env 설정 필요: MASTODON_URL, MASTODON_TOKEN");
  process.exit(1);
}

const rest      = createRestAPIClient({ url: INSTANCE_URL, accessToken: BOT_TOKEN });
const streaming = createStreamingAPIClient({
  streamingApiUrl: INSTANCE_URL.replace(/\/$/, "") + "/api/v1/streaming",
  accessToken:     BOT_TOKEN,
});

let BOT_HANDLE = "";

async function init() {
  const me   = await rest.v1.accounts.verifyCredentials();
  BOT_HANDLE = me.username;
  console.log("스케줄 봇 시작: @" + BOT_HANDLE);
}

async function reply(notification, text) {
  const chunks = splitText(text, 480);
  let replyId  = notification.status?.id;

  for (const chunk of chunks) {
    const status = await rest.v1.statuses.create({
      status:      `@${notification.account.acct} ${chunk}`,
      inReplyToId: replyId,
      visibility:  notification.status?.visibility ?? "unlisted",
    });
    replyId = status.id;
  }
}

function splitText(text, limit) {
  if (text.length <= limit) return [text];
  const chunks = [];
  while (text.length > 0) {
    chunks.push(text.slice(0, limit));
    text = text.slice(limit);
  }
  return chunks;
}

function parseTokens(content) {
  const plain   = content.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const matches = [...plain.matchAll(/\[([^\]]+)\]/g)];
  return matches.map((m) => {
    const parts = m[1].split("/");
    return { key: parts[0].trim(), value: parts[1]?.trim() ?? null };
  });
}

async function handleNotification(notification) {
  if (notification.type !== "mention")               return;
  if (!notification.status || !notification.account) return;

  const accountId   = notification.account.id;
  const acct        = notification.account.acct;
  const displayName = notification.account.displayName || acct;
  const isGM        = accountId === GM_ID;
  const tokens      = parseTokens(notification.status.content);

  if (tokens.length === 0) return;

  if (tokens.some((t) => t.key === "상태")) {
    const player = getPlayer(accountId, displayName);
    await reply(notification, buildStatusLine(player));
    return;
  }

  const scheduleTokens = tokens.filter((t) => t.key === "스케줄");

  if (scheduleTokens.length > 0) {

    if (isEnded(accountId, displayName)) {
      await reply(notification, "커뮤니티가 이미 종료되었습니다.");
      return;
    }

    if (hasSubmittedThisTurn(accountId, displayName)) {
      await reply(notification, "이번 턴 행동을 이미 제출했습니다.");
      return;
    }

    const player  = getPlayer(accountId, displayName);
    const age     = getAge(player.turn);
    const actions = scheduleTokens.map((t) => t.value).filter(Boolean);

    const errors = validateSchedule(actions, age);
    if (errors.length > 0) {
      await reply(notification, `제출 실패\n${errors.join("\n")}`);
      return;
    }

    const updated = processPlayer(accountId, (p) => applyActions(p, actions));
    if (!updated) return;

    const lastHistory = updated.history.at(-1);

    const actionLines = lastHistory.log.map((entry) => {
      const parts = [];
      if (entry.changes.length > 0) parts.push(entry.changes.join(", "));
      if (entry.goldDelta !== 0)     parts.push(`골드${entry.goldDelta > 0 ? "+" : ""}${entry.goldDelta}G`);
      if (entry.note)                parts.push(`(${entry.note})`);
      return `  ${entry.action}: ${parts.join(" / ") || entry.note || "-"}`;
    }).join("\n");

    const resultText = [
      `[${player.name}] ${lastHistory.turn}턴 결과`,
      actionLines,
      "",
      buildStatusLine(updated),
    ].join("\n");

    await rest.v1.statuses.create({
      status:     resultText.slice(0, 490),
      visibility: "public",
    });

    if (actions.includes("무사수행")) {
      await rest.v1.statuses.create({
        status:     `@${acct} 무사수행을 선택했습니다. 무사수행 봇에서 진행해주세요.`,
        visibility: "direct",
      });
    }

    await reply(notification, `${lastHistory.turn}턴 처리 완료. 결과가 공개 게시되었습니다.`);
    return;
  }

  if (!isGM) {
    await reply(notification, "알 수 없는 명령입니다.");
    return;
  }

  if (tokens.some((t) => t.key === "현황")) {
    const players = getAllPlayers();
    if (players.length === 0) {
      await reply(notification, "등록된 플레이어가 없습니다.");
      return;
    }
    const lines = players.map((p) => {
      const lastTurn = p.history.at(-1)?.turn ?? 0;
      const flag     = lastTurn === p.turn - 1 ? "[완료]" : "[대기]";
      return `${flag} ${p.name} / ${p.turn - 1}턴 완료 / 스트레스:${p.hidden.스트레스} 위험:${p.hidden.위험도}`;
    });
    await reply(notification, `[전체 현황]\n${lines.join("\n")}`);
    return;
  }

  if (tokens.some((t) => t.key === "상세")) {
    const targetName = tokens.find((t) => t.key === "상세")?.value;
    const players    = getAllPlayers();
    const list       = targetName
      ? players.filter((p) => p.name === targetName)
      : players;

    if (targetName && list.length === 0) {
      await reply(notification, `'${targetName}' 플레이어를 찾을 수 없습니다.`);
      return;
    }

    for (const p of list) {
      const pub    = Object.entries(p.stats).map(([k, v])  => `${k}:${v}`).join(" ");
      const hidden = Object.entries(p.hidden).map(([k, v]) => `${k}:${v}`).join(" ");
      await reply(notification,
        `[${p.name} 상세]\n공개: ${pub}\n숨김: ${hidden}\n골드: ${p.gold}G\n\n${buildStatusLine(p)}`
      );
    }
    return;
  }

  if (tokens.some((t) => t.key === "강제진행")) {
    const players = getAllPlayers().filter((p) => {
      const lastTurn = p.history.at(-1)?.turn ?? -1;
      return lastTurn < p.turn - 1;
    });

    if (players.length === 0) {
      await reply(notification, "처리할 플레이어가 없습니다.");
      return;
    }

    for (const p of players) {
      updatePlayer({ ...p, turn: p.turn + 1 });
    }

    await reply(notification, `${players.length}명을 강제로 다음 턴으로 넘겼습니다.`);
    return;
  }

  await reply(notification, "알 수 없는 명령입니다.");
}

async function main() {
  await init();
  console.log("스트리밍 연결 중...");

  const stream = await streaming.user.subscribe();

  for await (const event of stream) {
    if (event.event !== "notification") continue;

    const notification = event.payload;
    try {
      await handleNotification(notification);
      await rest.v1.notifications.dismiss({ id: notification.id });
    } catch (err) {
      console.error("알림 처리 오류:", err);
    }
  }
}

main().catch((err) => {
  console.error("봇 오류:", err);
  process.exit(1);
});
