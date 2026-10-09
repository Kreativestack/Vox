export type VoxRole = "listener" | "host";

export type LiveStatus = "waiting" | "live" | "paused" | "reconnecting";

export type ParticipantProfile = {
  displayName: string;
  role: VoxRole;
};

export type ChatMessage = {
  id: string;
  identity: string;
  displayName: string;
  role: VoxRole;
  text: string;
  sentAt: number;
};

export type ReactionSymbol = "🙌" | "🔥" | "❤️" | "🙏" | "😂" | "👏";

export type ReactionEvent = {
  id: string;
  identity: string;
  displayName: string;
  emoji: ReactionSymbol;
  sentAt: number;
};

export type StatusEvent = {
  id: string;
  status: Exclude<LiveStatus, "reconnecting">;
  sentAt: number;
};

export type ModerationEvent = {
  id: string;
  identity: string;
  sentAt: number;
};

export type RoomBroadcastState = {
  status: Exclude<LiveStatus, "reconnecting">;
  liveStartedAt: number | null;
  updatedAt: number;
};

export type VoxEvent =
  | ({ type: "chat" } & ChatMessage)
  | ({ type: "reaction" } & ReactionEvent)
  | ({ type: "status" } & StatusEvent)
  | ({ type: "moderation_remove" } & ModerationEvent);
