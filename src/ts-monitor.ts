import {
  getChannelDescription,
  findRespawnListChannel,
  findRespawnNumberChannel,
} from "./clientquery";
import {
  parseRespawnList,
  parseRespawnCatalog,
  RespawnEntry,
  RespawnCatalog,
  RespawnListData,
} from "./respawn-parser";
import {
  fetchReservations,
  getActiveReservations,
  ActiveReservation,
  ReservationData,
} from "./sheets-parser";
import { findReservationsForRespawnByCode, matchRespawnName } from "./respawn-matcher";
import { formatTable } from "./utils";
import dotenv from "dotenv";

dotenv.config();

const API_KEY = process.env.TS_APIKEY || "5AEH-W5S8-NGYT-ETWX-7WPK-0FV0";

function progressBar(percent: number): string {
  const width = 15;
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  return "\u2588".repeat(filled) + "\u2591".repeat(empty);
}

function statusEmoji(entry: RespawnEntry): string {
  if (entry.isEntryWindow) return "\uD83D\uDD35";
  if (entry.isAlmostDone) return "\uD83D\uDFE1";
  return "\uD83D\uDFE2";
}

async function fetchCatalog(): Promise<RespawnCatalog> {
  const numCh = await findRespawnNumberChannel(API_KEY);
  if (!numCh) return {};
  const desc = await getChannelDescription(numCh.cid, API_KEY);
  return parseRespawnCatalog(desc);
}

async function showRespawns(showFree: boolean = false): Promise<void> {
  console.log("Buscando dados via ClientQuery + Google Sheets...\n");

  const [channel, catalog, reservations] = await Promise.all([
    findRespawnListChannel(API_KEY),
    fetchCatalog(),
    fetchReservations().catch(() => null),
  ]);

  if (!channel) {
    console.error(
      "Canal 'Respawn List' nao encontrado. Voce esta conectado ao servidor?"
    );
    process.exit(1);
  }

  const desc = await getChannelDescription(channel.cid, API_KEY);
  const data = parseRespawnList(desc, catalog);

  // Get active reservations
  const activeReservations = reservations
    ? getActiveReservations(reservations.all)
    : [];

  console.log(`=== RESPAWN LIST === (${data.timestamp})`);
  console.log(
    `Ocupados: ${data.totalRespawns} / ${data.catalogTotal} respawns | Livres: ${data.freeRespawns.length}`
  );
  if (reservations) {
    console.log(
      `Reservas: ${reservations.all.length} total | ${activeReservations.filter((r) => r.isActiveNow).length} ativas agora | ${activeReservations.filter((r) => r.isUpcoming).length} proximas`
    );
  }
  console.log();

  // Check for reservation conflicts
  const headers = [
    "",
    "Code",
    "Respawn",
    "Tempo",
    "Restante",
    "Sai as",
    "Progresso",
    "Ocupado por",
    "Reservado",
    "Next",
  ];

  const rows = data.entries.map((e) => {
    // Find matching reservation using code-aware matcher
    let reservedInfo = "";
    if (reservations) {
      const matchingRes = findReservationsForRespawnByCode(e.code, e.name, reservations.all, catalog);
      const activeRes = getActiveReservations(matchingRes);
      if (activeRes.length > 0) {
        const r = activeRes[0];
        const status = r.isActiveNow ? "AGORA" : `em ${r.minutesUntilStart}m`;
        reservedInfo = `${r.player} (${status})`;
      }
    }

    let remainingText: string;
    if (e.status === "entryWindow") {
      remainingText = "TROCANDO";
    } else if (e.elapsedMinutes >= e.totalMinutes) {
      remainingText = "SAINDO";
    } else {
      remainingText = e.remainingFormatted;
    }

    return [
      statusEmoji(e),
      e.code,
      e.name,
      `${e.elapsedFormatted}/${e.totalFormatted}`,
      remainingText,
      e.expectedExit,
      `${progressBar(e.progressPercent)} ${e.progressPercent}%`,
      e.occupiedBy,
      reservedInfo,
      e.nexts > 0 ? `+${e.nexts}` : "",
    ];
  });

  console.log(formatTable(headers, rows));

  // Summary alerts
  const entryWindow = data.entries.filter((e) => e.isEntryWindow);
  const leaving = data.entries.filter((e) => e.elapsedMinutes >= e.totalMinutes && !e.isEntryWindow);
  const almostDone = data.entries.filter((e) => e.isAlmostDone);

  console.log();
  if (entryWindow.length > 0) {
    console.log(`\uD83D\uDD35 TROCANDO (${entryWindow.length}):`);
    entryWindow.forEach((e) => {
      const over = e.elapsedMinutes - e.totalMinutes;
      console.log(`   ${e.name} - ${e.occupiedBy} (${over}min alem, fila +${e.nexts})`);
    });
  }
  if (leaving.length > 0) {
    console.log(`\u23F3 SAINDO (${leaving.length}):`);
    leaving.forEach((e) => {
      const over = e.elapsedMinutes - e.totalMinutes;
      console.log(`   ${e.name} - ${e.occupiedBy} (${over}min alem, sem fila)`);
    });
  }
  if (almostDone.length > 0) {
    console.log(`\uD83D\uDFE1 QUASE ACABANDO (${almostDone.length}):`);
    almostDone.forEach((e) =>
      console.log(
        `   ${e.name} - ${e.occupiedBy} (faltam ${e.remainingMinutes}min, sai ~${e.expectedExit})`
      )
    );
  }

  // Reservations upcoming for free respawns (code-aware matching)
  if (activeReservations.length > 0) {
    const upcomingForFree = activeReservations.filter((r) => {
      const isOccupied = data.entries.some((e) => {
        const matchingRes = findReservationsForRespawnByCode(e.code, e.name, [r], catalog);
        return matchingRes.length > 0;
      });
      return !isOccupied;
    });

    if (upcomingForFree.length > 0) {
      console.log(`\n\uD83D\uDCC5 RESERVAS EM RESPAWNS LIVRES:`);
      upcomingForFree.forEach((r) => {
        const match = matchRespawnName(r.respawnName, catalog);
        const codeInfo = match ? ` [${match.code}]` : "";
        const status = r.isActiveNow
          ? "ATIVO AGORA"
          : `em ${r.minutesUntilStart}min`;
        console.log(
          `   [${r.type.toUpperCase()}]${codeInfo} ${r.respawnName} - ${r.player} (${r.entryTime}~${r.exitTime}) [${status}]`
        );
      });
    }
  }

  // Free respawns
  if (showFree && data.freeRespawns.length > 0) {
    console.log(`\n\u2705 RESPAWNS LIVRES (${data.freeRespawns.length}):`);
    const freeRows = data.freeRespawns.map((r) => [r.code, r.name]);
    console.log(formatTable(["Code", "Respawn"], freeRows));
  }
}

async function monitorLoop(intervalSec: number): Promise<void> {
  const refresh = async () => {
    try {
      console.clear();
      await showRespawns();
      console.log(
        `\nAtualiza em ${intervalSec}s... (Ctrl+C para sair)`
      );
    } catch (err: any) {
      console.error("Erro ao atualizar:", err.message);
    }
  };

  await refresh();
  setInterval(refresh, intervalSec * 1000);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] || "status";

  try {
    switch (command) {
      case "status":
        await showRespawns(false);
        break;

      case "full":
        await showRespawns(true);
        break;

      case "monitor": {
        const interval = parseInt(args[1] || "30");
        await monitorLoop(interval);
        await new Promise(() => {});
        break;
      }

      case "help":
        console.log("Uso: npx tsx src/ts-monitor.ts <comando>\n");
        console.log("Comandos:");
        console.log("  status  - Respawns ocupados + reservas (padrao)");
        console.log("  full    - Inclui lista de livres");
        console.log("  monitor - Loop automatico (ex: monitor 60)");
        console.log("  help    - Esta mensagem");
        break;

      default:
        console.error(`Comando desconhecido: ${command}`);
    }
  } catch (err: any) {
    if (err.code === "ECONNREFUSED") {
      console.error("ERRO: TeamSpeak nao esta rodando.");
    } else {
      console.error("ERRO:", err.message || err);
    }
    process.exit(1);
  }
}

main();
