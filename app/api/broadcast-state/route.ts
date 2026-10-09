import { NextResponse } from "next/server";
import { RoomServiceClient } from "livekit-server-sdk";

import { getRoomName, toLivekitApiHost } from "@/lib/livekit";
import type { RoomBroadcastState } from "@/lib/types";

export const runtime = "nodejs";

type BroadcastStateRequest = {
  passcode?: string;
  status?: RoomBroadcastState["status"];
  liveStartedAt?: number | null;
};

function getRequiredEnv() {
  const livekitUrl = process.env.LIVEKIT_URL?.trim();
  const apiKey = process.env.LIVEKIT_API_KEY?.trim();
  const apiSecret = process.env.LIVEKIT_API_SECRET?.trim();
  const hostPasscode = process.env.HOST_PASSCODE?.trim();

  if (!livekitUrl || !apiKey || !apiSecret || !hostPasscode) {
    throw new Error("Missing one or more required environment variables.");
  }

  return {
    livekitUrl,
    apiKey,
    apiSecret,
    hostPasscode,
  };
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as BroadcastStateRequest;
    const passcode = body.passcode?.trim();
    const env = getRequiredEnv();

    if (passcode !== env.hostPasscode) {
      return NextResponse.json({ error: "Incorrect host passcode." }, { status: 401 });
    }

    const status =
      body.status === "live" || body.status === "paused" || body.status === "waiting"
        ? body.status
        : null;

    if (!status) {
      return NextResponse.json({ error: "Valid broadcast status is required." }, { status: 400 });
    }

    const nextState: RoomBroadcastState = {
      status,
      liveStartedAt: status === "live" && typeof body.liveStartedAt === "number" ? body.liveStartedAt : null,
      updatedAt: Date.now(),
    };

    const roomService = new RoomServiceClient(
      toLivekitApiHost(env.livekitUrl),
      env.apiKey,
      env.apiSecret,
    );
    const room = await roomService.updateRoomMetadata(getRoomName(), JSON.stringify(nextState));

    return NextResponse.json({
      ok: true,
      metadata: room.metadata ?? JSON.stringify(nextState),
      state: nextState,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to update broadcast state.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
