import type { Metadata } from "next";

import { ListenerApp } from "@/components/listener-app";

export const metadata: Metadata = {
  title: "Listen",
};

export default function HomePage() {
  return <ListenerApp />;
}
