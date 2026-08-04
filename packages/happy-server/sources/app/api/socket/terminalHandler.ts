import { Server, Socket } from "socket.io";
import { Counter, register } from "prom-client";
import { log } from "@/utils/log";
import {
  TERMINAL_EVENTS,
  terminalEncryptedEnvelopeSchema,
} from "@slopus/happy-wire";

const terminalEventsForwarded = new Counter({
  name: "terminal_events_forwarded_total",
  help: "Terminal events forwarded between daemon and client",
  labelNames: ["event", "direction"] as const,
  registers: [register],
});

function isValidEnvelope(msg: unknown): msg is { scope: string; data: string } {
  return terminalEncryptedEnvelopeSchema.safeParse(msg).success;
}

export function terminalHandler(
  userId: string,
  socket: Socket,
  io: Server,
): void {
  const clientType = socket.data.clientType as string | undefined;
  const sessionId = socket.data.sessionId as string | undefined;

  // Daemon (session-scoped) → forwards to user's app clients
  if (clientType === "session-scoped" && sessionId) {
    socket.on(TERMINAL_EVENTS.output, (msg: unknown) => {
      if (!isValidEnvelope(msg)) return;
      terminalEventsForwarded.inc({ event: "output", direction: "daemon→client" });
      io.to(`user:${userId}:user-scoped`).volatile.emit(
        TERMINAL_EVENTS.output,
        msg,
      );
    });

    socket.on(TERMINAL_EVENTS.closed, (msg: unknown) => {
      if (!isValidEnvelope(msg)) return;
      terminalEventsForwarded.inc({ event: "closed", direction: "daemon→client" });
      io.to(`user:${userId}:user-scoped`).emit(TERMINAL_EVENTS.closed, msg);
    });

    log(
      { module: "terminal" },
      `Terminal handler attached for daemon session=${sessionId} user=${userId}`,
    );
  }

  // User-scoped client → forwards input to session daemon
  if (clientType === "user-scoped") {
    socket.on(TERMINAL_EVENTS.input, (msg: unknown) => {
      if (!isValidEnvelope(msg)) return;
      const envelope = msg as { scope: string; data: string };
      terminalEventsForwarded.inc({ event: "input", direction: "client→daemon" });
      io.to(`user:${userId}:session:${envelope.scope}`).emit(
        TERMINAL_EVENTS.input,
        envelope,
      );
    });
  }
}
