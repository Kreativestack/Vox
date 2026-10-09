import { NextResponse } from "next/server";
import { AccessToken } from "livekit-server-sdk";

import {
  createIdentity,
  getRoomName,
  MAX_DISPLAY_NAME_LENGTH,
  normalizeDisplayName,
} from "@/lib/livekit";
import type { ParticipantProfile, VoxRole } from "@/lib/types";

export const runtime = "nodejs";

type TokenRequest = {
  role: VoxRole;
  displayName?: string;
  passcode?: string;
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

function buildProfile(displayName: string, role: VoxRole): ParticipantProfile {
  return {
    displayName,
    role,
  };
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as TokenRequest;
    const role = body.role === "host" ? "host" : "listener";
    const displayName = normalizeDisplayName(body.displayName ?? "");

    if (!displayName) {
      return NextResponse.json({ error: "Display name is required." }, { status: 400 });
    }

    if (displayName.length > MAX_DISPLAY_NAME_LENGTH) {
      return NextResponse.json(
        { error: `Display name must be ${MAX_DISPLAY_NAME_LENGTH} characters or fewer.` },
        { status: 400 },
      );
    }

    const env = getRequiredEnv();
    if (role === "host" && body.passcode !== env.hostPasscode) {
      return NextResponse.json({ error: "Incorrect host passcode." }, { status: 401 });
    }

    const identity = createIdentity(role === "host" ? "host" : "guest");
    const profile = buildProfile(displayName, role);

    const token = new AccessToken(env.apiKey, env.apiSecret, {
      identity,
      name: displayName,
      metadata: JSON.stringify(profile),
      ttl: "8h",
    });

    token.addGrant({
      roomJoin: true,
      room: getRoomName(),
      canSubscribe: true,
      canPublishData: true,
      canPublish: role === "host",
    });

    return NextResponse.json({
      token: await token.toJwt(),
      livekitUrl: env.livekitUrl,
      roomName: getRoomName(),
      identity,
      profile,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to create token.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
