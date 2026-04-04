// ============================================================
// bot.js — 스케줄 봇
// ============================================================
import "dotenv/config";
import { createRestAPIClient, createStreamingAPIClient } from "masto";
import {
  getAge,
  getPhase,
  validateSchedule,
  applyActions,
  buildStatusLine,
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
const BOT_TOKEN    = process.env.BOT_TOKEN;
const INSTANCE_URL = process.env.MASTODON_URL;
const MAX_TURNS    = Number(process.env.MAX_TURNS ?? 24);

if (!BOT_TOKEN || !INSTANCE_URL) {
  console.error(".env 설정 필요: MASTODON_URL, BOT_TOKEN");
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

// ── 메시지 유틸 ───────────────────────────────────────────────

function parseTokens(content) {
  const plain   = content.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const matches = [...plain.matchAll(/\[([^\]]+)\]/g)];
  return matches.map((m) => {
    const parts = m[1].split("/");
    return { key: parts[0].trim(), value: parts[1]?.trim() ?? null };
  });
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

async function reply(notification, text) {
  const chunks  = splitText(text, 480);
  let   replyId = notification.status?.id;
  for (const chunk of chunks) {
    const status = await rest.v1.statuses.create({
      status:      `@${notification.account.acct} ${chunk}`,
      inReplyToId: replyId,
      visibility:  notification.status?.visibility ?? "unlisted",
    });
    replyId = status.id;
  }
}

async function postPublic(text) {
  await rest.v1.statuses.create({
    status:     text.slice(0, 490),
    visibility: "public",
  });
}

// ── 명령 핸들러 ───────────────────────────────────────────────

// [상태]
async function handleStatus(notification, accountId, displayName) {
  const player = await getPlayer(accountId, displayName);
  await reply(notification, buildStatusLine(player));
}

// [스케줄/행동1] [스케줄/행동2] [스케줄/행동3]
async function handleSchedule(notification, accountId, displayName, scheduleTokens) {
  // 종료 확인
  if (await isEnded(accountId, displayName)) {
    await reply(notification, "커뮤니티가 이미 종료되었습니다.");
    return;
  }

  // 중복 제출 확인
  if (await hasSubmittedThisTurn(accountId, displayName)) {
    await reply(notification, "이번 턴 행동을 이미 제출했습니다.");
    return;
  }

  const player  = await getPlayer(accountId, displayName);
  const age     = getAge(player.turn);
  const actions = scheduleTokens.map((t) => t.value).filter(Boolean);

  // 유효성 검사
  const errors = await validateSchedule(actions, age);
  if (errors.length > 0) {
    await reply(notification, `제출 실패\n${errors.join("\n")}`);
    return;
  }

  // 행동 적용
  const updated = await processPlayer(accountId, (p) => {
    // applyActions는 async지만 processPlayer 내부에서는 동기 함수만 허용
    // 때문에 아래에서 별도 처리
    return p;
  });

  // applyActions는 async이므로 processPlayer 밖에서 처리
  const raw     = await getPlayer(accountId, displayName);
  const applied = await applyActions(raw, actions);
  await updatePlayer(applied);

  const lastHistory = applied.history.at(-1);

  // 결과 텍스트 생성
  const actionLines = lastHistory.log.map((entry) => {
    const parts = [];
    if (entry.changes.length > 0) parts.push(entry.changes.join(", "));
    if (entry.goldDelta !== 0)    parts.push(`골드${entry.goldDelta > 0 ? "+" : ""}${entry.goldDelta}G`);
    if (entry.note)               parts.push(`(${entry.note})`);
    return `  ${entry.action}: ${parts.join(" / ") || "-"}`;
  }).join("\n");

  const resultText = [
    `[${applied.name}] ${lastHistory.turn}턴 결과`,
    actionLines,
    "",
    buildStatusLine(applied),
  ].join("\n");

  // 결과 공개 게시
  await postPublic(resultText);

  // 무사수행 포함 시 DM 안내
  if (actions.includes("무사수행")) {
    await rest.v1.statuses.create({
      status:     `@${notification.account.acct} 무사수행을 선택했습니다. 무사수행 봇에 [무사수행] 또는 [무사수행/마물명]을 멘션하여 진행해주세요.`,
      visibility: "direct",
    });
  }

  await reply(notification, `${lastHistory.turn}턴 처리 완료. 결과가 공개 게시되었습니다.`);
}

// ── GM 전용 명령 ──────────────────────────────────────────────

// [현황]
async function handleGMStatus(notification) {
  const players = await getAllPlayers();
  if (players.length === 0) {
    await reply(notification, "등록된 플레이어가 없습니다.");
    return;
  }

  const lines = players.map((p) => {
    const lastTurn = p.history.at(-1)?.turn ?? 0;
    const flag     = lastTurn === p.turn - 1 ? "[완료]" : "[대기]";
    const hasAdv   = p.history.at(-1)?.actions?.includes("무사수행") ?? false;
    const advDone  = p.history.at(-1)?.adventureResult != null;
    const advFlag  = hasAdv ? (advDone ? "[무사수행완료]" : "[무사수행대기]") : "";
    return `${flag} ${p.name} / ${p.turn - 1}턴 완료 ${advFlag} / 스트레스:${p.hidden.스트레스} 위험도:${p.hidden.위험도}`;
  });

  await reply(notification, `[전체 현황]\n${lines.join("\n")}`);
}

// [상세] or [상세/이름]
async function handleGMDetail(notification, targetName) {
  const players = await getAllPlayers();
  const list    = targetName
    ? players.filter((p) => p.name === targetName)
    : players;

  if (targetName && list.length === 0) {
    await reply(notification, `'${targetName}' 플레이어를 찾을 수 없습니다.`);
    return;
  }

  for (const p of list) {
    const pub    = Object.entries(p.stats).map(([k, v])  => `${k}:${v}`).join(" ");
    const hidden = Object.entries(p.hidden).map(([k, v]) => `${k}:${v}`).join(" ");
    const inv    = p.inventory.length > 0 ? p.inventory.join(", ") : "없음";
    const equip  = Object.entries(p.equipped).length > 0
      ? Object.entries(p.equipped).map(([slot, name]) => `${slot}:${name}`).join(" ")
      : "없음";

    await reply(notification,
      `[${p.name} 상세]\n` +
      `공개: ${pub}\n` +
      `숨김: ${hidden}\n` +
      `골드: ${p.gold}G\n` +
      `인벤토리: ${inv}\n` +
      `장착: ${equip}\n\n` +
      buildStatusLine(p)
    );
  }
}

// [강제진행] — 미제출 플레이어를 다음 턴으로 강제 이동
async function handleGMForce(notification) {
  const players = await getAllPlayers();
  const pending = players.filter((p) => {
    const lastTurn = p.history.at(-1)?.turn ?? 0;
    return lastTurn < p.turn - 1;
  });

  if (pending.length === 0) {
    await reply(notification, "처리할 플레이어가 없습니다.");
    return;
  }

  for (const p of pending) {
    await updatePlayer({ ...p, turn: p.turn + 1 });
  }

  await reply(notification, `${pending.length}명을 강제로 다음 턴으로 넘겼습니다.`);
}

// [골드지급/이름/금액] — GM이 특정 플레이어에게 골드 지급
async function handleGMGold(notification, targetName, amountStr) {
  if (!targetName || !amountStr) {
    await reply(notification, "사용법: [골드지급/플레이어명/금액]");
    return;
  }

  const amount  = parseInt(amountStr, 10);
  if (isNaN(amount)) {
    await reply(notification, "금액은 정수로 입력해주세요.");
    return;
  }

  const players = await getAllPlayers();
  const target  = players.find((p) => p.name === targetName);
  if (!target) {
    await reply(notification, `'${targetName}' 플레이어를 찾을 수 없습니다.`);
    return;
  }

  await updatePlayer({ ...target, gold: target.gold + amount });
  await reply(notification,
    `[${targetName}] 골드 ${amount > 0 ? "+" : ""}${amount}G 지급 완료.\n현재 잔액: ${target.gold + amount}G`
  );
}

// [수치조정/이름/수치명/값] — GM이 수치 직접 조정
async function handleGMStat(notification, targetName, statName, valueStr) {
  if (!targetName || !statName || !valueStr) {
    await reply(notification, "사용법: [수치조정/플레이어명/수치명/값]");
    return;
  }

  const value   = parseInt(valueStr, 10);
  if (isNaN(value)) {
    await reply(notification, "값은 정수로 입력해주세요.");
    return;
  }

  const players = await getAllPlayers();
  const target  = players.find((p) => p.name === targetName);
  if (!target) {
    await reply(notification, `'${targetName}' 플레이어를 찾을 수 없습니다.`);
    return;
  }

  const PUBLIC_STATS = ["지능", "매력", "체력", "감성", "사회성"];
  const HIDDEN_STATS = ["도덕성", "야망", "위험도", "의존성", "스트레스", "평판", "전투"];
  const clamp = (v) => Math.min(100, Math.max(0, v));

  let updated;
  if (PUBLIC_STATS.includes(statName)) {
    updated = { ...target, stats: { ...target.stats, [statName]: clamp(value) } };
  } else if (HIDDEN_STATS.includes(statName)) {
    updated = { ...target, hidden: { ...target.hidden, [statName]: clamp(value) } };
  } else {
    await reply(notification, `'${statName}'은(는) 없는 수치입니다.`);
    return;
  }

  await updatePlayer(updated);
  await reply(notification, `[${targetName}] ${statName} → ${clamp(value)} 조정 완료.`);
}

// [공지/내용] — GM 공지를 공개 게시
async function handleGMAnnounce(notification, content) {
  if (!content) {
    await reply(notification, "사용법: [공지/내용]");
    return;
  }

  await postPublic(`[공지]\n${content}`);
  await reply(notification, "공지가 게시되었습니다.");
}

// ── 명령 분기 ─────────────────────────────────────────────────

async function handleNotification(notification) {
  if (notification.type !== "mention")               return;
  if (!notification.status || !notification.account) return;

  const accountId   = notification.account.id;
  const acct        = notification.account.acct;
  const displayName = notification.account.displayName || acct;
  const isGM        = accountId === GM_ID;
  const tokens      = parseTokens(notification.status.content);

  if (tokens.length === 0) return;

  // [상태]
  if (tokens.some((t) => t.key === "상태")) {
    await handleStatus(notification, accountId, displayName);
    return;
  }

  // [스케줄/행동명] x3
  const scheduleTokens = tokens.filter((t) => t.key === "스케줄");
  if (scheduleTokens.length > 0) {
    await handleSchedule(notification, accountId, displayName, scheduleTokens);
    return;
  }

  // GM 전용 명령
  if (!isGM) {
    await reply(notification, "알 수 없는 명령입니다.");
    return;
  }

  for (const token of tokens) {
    switch (token.key) {
      case "현황":
        await handleGMStatus(notification);
        break;

      case "상세":
        await handleGMDetail(notification, token.value);
        break;

      case "강제진행":
        await handleGMForce(notification);
        break;

      case "골드지급": {
        const parts = token.value?.split(",") ?? [];
        await handleGMGold(notification, parts[0]?.trim(), parts[1]?.trim());
        break;
      }

      case "수치조정": {
        // [수치조정/이름/수치명/값] → value = "이름", extra 없으므로 토큰 재파싱
        const raw   = notification.status.content.replace(/<[^>]+>/g, " ");
        const match = raw.match(/\[수치조정\/([^/]+)\/([^/]+)\/([^\]]+)\]/);
        if (match) {
          await handleGMStat(notification, match[1].trim(), match[2].trim(), match[3].trim());
        } else {
          await reply(notification, "사용법: [수치조정/플레이어명/수치명/값]");
        }
        break;
      }

      case "공지":
        await handleGMAnnounce(notification, token.value);
        break;

      default:
        await reply(notification, "알 수 없는 명령입니다.");
        break;
    }
  }
}

// ── 시작 ─────────────────────────────────────────────────────

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
