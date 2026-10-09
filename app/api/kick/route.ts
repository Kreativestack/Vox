import { NextResponse } from "next/server";
import { RoomServiceClient } from "livekit-server-sdk";

import { getRoomName, toLivekitApiHost } from "@/lib/livekit";

export const runtime = "nodejs";

type KickRequest = {
  passcode?: string;
  identity?: string;
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
    const body = (await request.json()) as KickRequest;
    const identity = body.identity?.trim();
    const passcode = body.passcode?.trim();
    const env = getRequiredEnv();

    if (!identity) {
      return NextResponse.json({ error: "Participant identity is required." }, { status: 400 });
    }

    if (passcode !== env.hostPasscode) {
      return NextResponse.json({ error: "Incorrect host passcode." }, { status: 401 });
    }

    const roomService = new RoomServiceClient(
      toLivekitApiHost(env.livekitUrl),
      env.apiKey,
      env.apiSecret,
    );
    await roomService.removeParticipant(getRoomName(), identity);

    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to remove participant.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
