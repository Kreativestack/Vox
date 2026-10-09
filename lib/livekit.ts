import { Participant, RoomEvent } from "livekit-client";

import type { ParticipantProfile, RoomBroadcastState, VoxEvent } from "@/lib/types";

export const DATA_TOPIC = "vox-events";
export const LISTENER_NAME_STORAGE_KEY = "vox-listener-name";
export const MAX_DISPLAY_NAME_LENGTH = 24;
export const MAX_COMMENT_LENGTH = 280;
export const REACTION_COOLDOWN_MS = 1200;
export const REACTION_OPTIONS = ["🙌", "🔥", "❤️", "🙏", "😂", "👏"] as const;

export function getProgrammeName() {
  return process.env.NEXT_PUBLIC_PROGRAMME_NAME?.trim() || "Youth Live Saturday";
}

export function getRoomName() {
  return process.env.ROOM_NAME?.trim() || "vox-main-room";
}

export function toLivekitApiHost(url: string) {
  if (url.startsWith("wss://")) {
    return url.replace("wss://", "https://");
  }

  if (url.startsWith("ws://")) {
    return url.replace("ws://", "http://");
  }

  return url;
}

export function normalizeDisplayName(value: string) {
  return value.trim().replace(/\s+/g, " ").slice(0, MAX_DISPLAY_NAME_LENGTH);
}

export function createIdentity(prefix: "host" | "guest") {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

export function encodeEvent(event: VoxEvent) {
  return new TextEncoder().encode(JSON.stringify(event));
}

export function decodeEvent(payload: Uint8Array): VoxEvent | null {
  try {
    return JSON.parse(new TextDecoder().decode(payload)) as VoxEvent;
  } catch {
    return null;
  }
}

export function parseParticipantProfile(participant?: Participant | null): ParticipantProfile {
  if (!participant) {
    return {
      displayName: "Guest",
      role: "listener",
    };
  }

  try {
    const parsed = JSON.parse(participant.metadata ?? "{}") as Partial<ParticipantProfile>;
    return {
      displayName: typeof parsed.displayName === "string" ? parsed.displayName : participant.name || "Guest",
      role: parsed.role === "host" ? "host" : "listener",
    };
  } catch {
    return {
      displayName: participant.name || "Guest",
      role: "listener",
    };
  }
}

export function findHostParticipant(participants: Participant[]) {
  return participants.find((participant) => parseParticipantProfile(participant).role === "host") ?? null;
}

export function hasPublishedMicrophone(participant?: Participant | null) {
  if (!participant) {
    return false;
  }

  return Array.from(participant.trackPublications.values()).some(
    (publication) =>
      publication.source === "microphone" &&
      publication.isSubscribed !== false &&
      publication.trackSid,
  );
}

export function statusLabel(status: string) {
  switch (status) {
    case "live":
      return "Live now";
    case "paused":
      return "Paused";
    case "reconnecting":
      return "Reconnecting";
    default:
      return "Waiting for the host";
  }
}

export function roomEventNames() {
  return {
    data: RoomEvent.DataReceived,
    audioPlayback: RoomEvent.AudioPlaybackStatusChanged,
  };
}

export function parseRoomBroadcastState(metadata?: string | null): RoomBroadcastState {
  if (!metadata) {
    return {
      status: "waiting",
      liveStartedAt: null,
      updatedAt: 0,
    };
  }

  try {
    const parsed = JSON.parse(metadata) as Partial<RoomBroadcastState>;
    return {
      status:
        parsed.status === "live" || parsed.status === "paused" || parsed.status === "waiting"
          ? parsed.status
          : "waiting",
      liveStartedAt: typeof parsed.liveStartedAt === "number" ? parsed.liveStartedAt : null,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
    };
  } catch {
    return {
      status: "waiting",
      liveStartedAt: null,
      updatedAt: 0,
    };
  }
}

export function formatElapsedTime(elapsedMs: number) {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts = [minutes, seconds].map((value) => value.toString().padStart(2, "0"));
  if (hours > 0) {
    parts.unshift(hours.toString().padStart(2, "0"));
  }

  return parts.join(":");
}
