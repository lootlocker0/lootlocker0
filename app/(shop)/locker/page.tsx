import type { Metadata } from "next";
import { LockerSignIn } from "@/components/account/LockerSignIn";

export const metadata: Metadata = {
  title: "The Locker | LootLockers",
  description: "Create your LootLockers account and track your rewards.",
};

export default async function LockerPage({
  searchParams,
}: {
  searchParams: Promise<{ oauth?: string }>;
}) {
  const params = await searchParams;
  return <LockerSignIn oauthMessage={params.oauth === "not_configured" ? "Google sign-in needs to be configured by the site owner." : undefined} />;
}