import type { Metadata } from "next";

import { HostApp } from "@/components/host-app";

export const metadata: Metadata = {
  title: "Host",
};

export default function HostPage() {
  return <HostApp />;
}
